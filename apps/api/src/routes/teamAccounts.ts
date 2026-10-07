import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  mayManageMemberAccount,
  memberAccountRequestSchema,
  type Role,
  type WorkspacePermission,
} from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { accessChanged } from '../lib/accessEvents.js';
import { notifyServerAdmins } from '../lib/serverAdmins.js';
import { publishToUser, publishToWorkspace } from '../chat/hub.js';

/**
 * Team leads acting on people on their teams. Who may is
 * `mayManageMemberAccount` in packages/shared, with `teams.accounts` as the
 * permission a role grants.
 *
 * Within the workspace, a lead can suspend someone, which takes their
 * membership out of workspace_members until it is lifted (see migration 0040),
 * and lift it again. Beyond it, they can only ask: the server's administrators
 * are asked to disable or delete the account, are told who asked and from where,
 * and decide. The person is told too.
 */

interface Target {
  userId: string;
  name: string;
  workspaceName: string;
  isServerAdmin: boolean;
  /** Whether their membership is suspended rather than live. */
  suspended: boolean;
}

/** Everyone with the workspace open refreshes who is in it. */
function membersChanged(workspaceId: string): void {
  publishToWorkspace(workspaceId, { type: 'members.changed', workspaceId });
}

/**
 * Resolves the person being acted on, a member or someone suspended from the
 * workspace, refusing anyone the caller may not act on.
 */
async function authorise(req: FastifyRequest<{ Params: { id: string; userId: string } }>): Promise<Target> {
  const workspaceId = req.params.id;
  const actorId = req.user!.id;
  const actor = await assertWorkspaceAccess(req, workspaceId);

  const { rows } = await query<{
    name: string;
    is_server_admin: boolean;
    workspace_name: string;
    role: Role | null;
    suspended: boolean;
    share_team: boolean;
  }>(
    `SELECT u.name, u.is_server_admin, w.name AS workspace_name,
            COALESCE(m.role, s.role) AS role, s.user_id IS NOT NULL AS suspended,
            EXISTS (SELECT 1 FROM team_members mine
                      JOIN team_members theirs ON theirs.team_id = mine.team_id
                      JOIN teams t ON t.id = mine.team_id
                     WHERE t.workspace_id = $1 AND mine.user_id = $2 AND theirs.user_id = $3) AS share_team
       FROM users u
       JOIN workspaces w ON w.id = $1
       LEFT JOIN workspace_members m ON m.workspace_id = $1 AND m.user_id = u.id
       LEFT JOIN workspace_suspensions s ON s.workspace_id = $1 AND s.user_id = u.id
      WHERE u.id = $3`,
    [workspaceId, actorId, req.params.userId],
  );
  const row = rows[0];
  if (!row?.role) throw notFound('That person is not a member of this workspace');

  const allowed = mayManageMemberAccount(
    { id: actorId, role: actor.role, can: (p: WorkspacePermission) => actor.permissions.has(p) },
    { id: req.params.userId, role: row.role },
    row.share_team,
  );
  if (!allowed) {
    throw forbidden(
      req.params.userId === actorId
        ? 'You cannot do this to yourself'
        : row.role !== 'member' && actor.role !== 'owner'
          ? 'Only an owner can do this to an admin, and nobody can do it to an owner'
          : "You can only do this for people on a team you are on, if your role lets you manage team members' access",
    );
  }
  return {
    userId: req.params.userId,
    name: row.name,
    workspaceName: row.workspace_name,
    isServerAdmin: row.is_server_admin,
    suspended: row.suspended,
  };
}

export const teamAccountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /** Suspends someone from this workspace. Their account and other workspaces are untouched. */
  app.post<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId/suspend',
    async (req, reply) => {
      const workspaceId = req.params.id;
      const target = await authorise(req);
      if (target.suspended) {
        reply.status(204);
        return;
      }

      await transaction(async (client) => {
        const { rows } = await client.query<{ role: Role; role_id: string; created_at: string }>(
          `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
           RETURNING role, role_id, created_at`,
          [workspaceId, target.userId],
        );
        if (!rows[0]) throw notFound('That person is not a member of this workspace');
        await client.query(
          `INSERT INTO workspace_suspensions
             (workspace_id, user_id, role, role_id, joined_at, suspended_by, suspended_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [workspaceId, target.userId, rows[0].role, rows[0].role_id, rows[0].created_at, req.user!.id, req.user!.name],
        );
      });

      membersChanged(workspaceId);
      // Open documents, channels and calls of theirs in this workspace close now.
      accessChanged(workspaceId);
      publishToUser(target.userId, { type: 'notifications.changed' });
      req.log.warn({ userId: target.userId, by: req.user!.id, workspaceId }, 'member suspended from workspace');
      reply.status(204);
    },
  );

  /** Lifts a suspension: they come back with the role, teams and access they had. */
  app.delete<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId/suspension',
    async (req, reply) => {
      const workspaceId = req.params.id;
      const target = await authorise(req);
      if (!target.suspended) {
        reply.status(204);
        return;
      }

      await transaction(async (client) => {
        const { rows } = await client.query<{ role: Role; role_id: string | null; joined_at: string }>(
          `DELETE FROM workspace_suspensions WHERE workspace_id = $1 AND user_id = $2
           RETURNING role, role_id, joined_at`,
          [workspaceId, target.userId],
        );
        if (!rows[0]) return;
        // A role deleted meanwhile leaves role_id null, and the membership
        // trigger then gives them the role their `role` names, or the default.
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role, role_id, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, target.userId, rows[0].role, rows[0].role_id, rows[0].joined_at],
        );
      });

      membersChanged(workspaceId);
      accessChanged(workspaceId);
      publishToUser(target.userId, { type: 'notifications.changed' });
      req.log.info({ userId: target.userId, by: req.user!.id, workspaceId }, 'workspace suspension lifted');
      reply.status(204);
    },
  );

  /** Asks the server's administrators to disable or delete someone's account. */
  app.post<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId/account-request',
    async (req, reply) => {
      const input = parse(memberAccountRequestSchema, req.body ?? {});
      const target = await authorise(req);
      if (target.isServerAdmin) {
        throw forbidden('Server administrators can only be changed by another administrator, on the server admin page');
      }

      // One request stands at a time. Deleting goes further than disabling, so
      // asking to delete replaces a request to disable, and nothing else
      // replaces what is already there.
      const { rows } = await query<{ account_request: 'delete' | 'disable' | null; disabled: boolean }>(
        'SELECT account_request, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1',
        [target.userId],
      );
      const current = rows[0];
      if (input.kind === 'disable' && current?.disabled) throw badRequest(`${target.name}’s account is already disabled`);
      const replaces = !current?.account_request || (current.account_request === 'disable' && input.kind === 'delete');

      if (replaces) {
        await query(
          `UPDATE users
              SET account_request = $2, account_requested_at = now(), account_request_note = $3,
                  account_requested_by_lead = true, account_requested_by = $4,
                  account_requested_by_name = $5, account_requested_workspace_name = $6,
                  account_member_note = NULL
            WHERE id = $1`,
          [target.userId, input.kind, input.note || null, req.user!.id, req.user!.name, target.workspaceName],
        );
        membersChanged(req.params.id);
        await notifyServerAdmins();
        // They are told, and can say something to the administrators.
        publishToUser(target.userId, { type: 'notifications.changed' });
        req.log.info(
          { userId: target.userId, by: req.user!.id, workspaceId: req.params.id, kind: input.kind },
          'team lead asked server administrators about an account',
        );
      }
      reply.status(204);
    },
  );
};
