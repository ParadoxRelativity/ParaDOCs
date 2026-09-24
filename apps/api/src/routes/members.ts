import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createInviteSchema, updateMemberSchema } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess, workspaceMembership } from '../plugins/session.js';
import { assertMayGrant, loadRole, type RoleRow } from '../lib/workspaceRoles.js';
import { managesAccess, permissionList } from '../lib/roles.js';
import { publishToWorkspace } from '../chat/hub.js';
import { accessChanged } from '../lib/accessEvents.js';

/** Everyone with the workspace open refreshes who is in it. */
function membersChanged(workspaceId: string): void {
  publishToWorkspace(workspaceId, { type: 'members.changed', workspaceId });
}

/** Owners must never be able to remove the last owner from a workspace. */
async function countOwners(workspaceId: string): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workspace_members
      WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return rows[0].count;
}

const INVITE_COLUMNS = `i.id, i.workspace_id AS "workspaceId", i.email,
  json_build_object('id', r.id, 'name', r.name) AS role, i.token,
  i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", i.created_at AS "createdAt"`;

/** The role an invite joins with: the one asked for, or the workspace's default. Never Owner. */
async function inviteRole(workspaceId: string, roleId: string | undefined): Promise<RoleRow> {
  if (!roleId) {
    const { rows } = await query<{ id: string }>(
      `SELECT COALESCE(w.default_role_id,
                       (SELECT r.id FROM workspace_roles r WHERE r.workspace_id = w.id AND r.system IS NULL
                         ORDER BY r.position LIMIT 1)) AS id
         FROM workspaces w WHERE w.id = $1`,
      [workspaceId],
    );
    if (!rows[0]?.id) throw badRequest('Choose a role for this invite');
    roleId = rows[0].id;
  }
  const role = await loadRole(workspaceId, roleId);
  if (role.system === 'owner') throw badRequest('Nobody can be invited as an owner. Invite them, then make them one.');
  return role;
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/workspaces/:id/members', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT m.user_id AS "userId", u.name, u.email, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl", m.role,
              json_build_object('id', r.id, 'name', r.name) AS "workspaceRole",
              m.created_at AS "joinedAt", (m.user_id = $2) AS "isSelf"
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         JOIN workspace_roles r ON r.id = m.role_id
        WHERE m.workspace_id = $1
        ORDER BY r.position, lower(r.name), lower(u.name)`,
      [req.params.id, req.user!.id],
    );
    return rows;
  });

  app.patch<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    async (req) => {
      const actor = await assertWorkspaceAccess(req, req.params.id, 'manage');
      const input = parse(updateMemberSchema, req.body);

      const target = await workspaceMembership(req.params.userId, req.params.id);
      if (!target) throw notFound('That person is not a member of this workspace');
      const role = await loadRole(req.params.id, input.roleId);

      // Admins cannot touch owners, and only owners can mint new owners.
      if (actor.role !== 'owner' && (target.role === 'owner' || role.system === 'owner')) {
        throw forbidden('Only an owner can change owner roles');
      }
      if (target.role === 'owner' && role.system !== 'owner' && (await countOwners(req.params.id)) <= 1) {
        throw badRequest('A workspace must keep at least one owner');
      }

      const { rows } = await query(
        `UPDATE workspace_members SET role_id = $3
          WHERE workspace_id = $1 AND user_id = $2
          RETURNING user_id AS "userId", role`,
        [req.params.id, req.params.userId, role.id],
      );
      membersChanged(req.params.id);
      // A role sets how far a lock reaches: owners and admins pass every one,
      // and nobody gets past what their role allows.
      accessChanged(req.params.id);
      return { ...rows[0], workspaceRole: { id: role.id, name: role.name } };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    async (req, reply) => {
      const leaving = req.params.userId === req.user!.id;
      // Anyone may remove themselves; removing someone else needs an owner or admin.
      const actor = await assertWorkspaceAccess(req, req.params.id, leaving ? undefined : 'manage');

      const target = await workspaceMembership(req.params.userId, req.params.id);
      if (!target) throw notFound('That person is not a member of this workspace');
      if (!leaving && target.role === 'owner' && actor.role !== 'owner') {
        throw forbidden('Only an owner can remove another owner');
      }
      if (target.role === 'owner' && (await countOwners(req.params.id)) <= 1) {
        throw badRequest('A workspace must keep at least one owner');
      }

      await transaction(async (client) => {
        await client.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
          req.params.id,
          req.params.userId,
        ]);
        // Their place on the workspace's teams and lists goes with them, so
        // rejoining later starts from the workspace's defaults, not old locks.
        await client.query(
          `DELETE FROM team_members tm USING teams t
            WHERE t.id = tm.team_id AND t.workspace_id = $1 AND tm.user_id = $2`,
          [req.params.id, req.params.userId],
        );
        await client.query(
          `DELETE FROM access_entries e
            WHERE e.user_id = $2
              AND (e.folder_id IN (SELECT id FROM folders WHERE workspace_id = $1)
                OR e.document_id IN (SELECT id FROM documents WHERE workspace_id = $1)
                OR e.spreadsheet_id IN (SELECT id FROM spreadsheets WHERE workspace_id = $1)
                OR e.channel_id IN (SELECT id FROM channels WHERE workspace_id = $1)
                OR e.project_id IN (SELECT id FROM projects WHERE workspace_id = $1))`,
          [req.params.id, req.params.userId],
        );
      });
      membersChanged(req.params.id);
      accessChanged(req.params.id);
      reply.status(204);
    },
  );

  // --- invitations ---------------------------------------------------------

  app.get<{ Params: { id: string } }>('/workspaces/:id/invites', async (req) => {
    const actor = await assertWorkspaceAccess(req, req.params.id, 'members.invite');
    // Each invite carries the token that accepts it, so someone who is not an
    // owner or admin sees only those they could have sent themselves, as
    // `assertMayGrant` decides: a link to a broader role would let them in
    // past their own.
    const { rows } = await query(
      `SELECT ${INVITE_COLUMNS}, u.name AS "invitedBy"
         FROM workspace_invites i
         JOIN workspace_roles r ON r.id = i.role_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()
          AND ($2::boolean OR (r.system IS NULL AND r.permissions <@ $3::text[]))
        ORDER BY i.created_at DESC`,
      [req.params.id, managesAccess(actor.role), permissionList(actor)],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/invites', async (req, reply) => {
    const actor = await assertWorkspaceAccess(req, req.params.id, 'members.invite');
    const input = parse(createInviteSchema, req.body ?? {});
    const role = await inviteRole(req.params.id, input.roleId);
    assertMayGrant(actor, role);

    if (input.email) {
      const { rows } = await query(
        `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND lower(u.email) = lower($2)`,
        [req.params.id, input.email],
      );
      if (rows.length) throw conflict('That person is already a member of this workspace');
    }

    // Tied to whoever has the address now; see migration 0028. Nobody else
    // is shown it, whatever address they give themselves later.
    const { rows: invitee } = input.email
      ? await query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [input.email])
      : { rows: [] };

    const token = randomBytes(24).toString('base64url');
    const { rows } = await query(
      `WITH i AS (
         INSERT INTO workspace_invites (workspace_id, email, role_id, token, invited_by, expires_at, invitee_id)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval, $7)
         RETURNING *
       )
       SELECT ${INVITE_COLUMNS} FROM i JOIN workspace_roles r ON r.id = i.role_id`,
      [
        req.params.id,
        input.email ?? null,
        role.id,
        token,
        req.user!.id,
        String(input.expiresInDays),
        invitee[0]?.id ?? null,
      ],
    );
    reply.status(201);
    return rows[0];
  });

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/workspaces/:id/invites/:inviteId',
    async (req, reply) => {
      const actor = await assertWorkspaceAccess(req, req.params.id, 'members.invite');
      const { rows } = await query<{ role_id: string }>(
        'SELECT role_id FROM workspace_invites WHERE id = $1 AND workspace_id = $2',
        [req.params.inviteId, req.params.id],
      );
      // Someone who may not invite with a role may not take back an invite with it either.
      if (rows[0]) assertMayGrant(actor, await loadRole(req.params.id, rows[0].role_id));
      await query('DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2', [
        req.params.inviteId,
        req.params.id,
      ]);
      reply.status(204);
    },
  );
};

/** Invite redemption. Separate because the invitee is not yet a member. */
export const inviteRoutes: FastifyPluginAsync = async (app) => {
  interface InviteRow {
    id: string;
    workspace_id: string;
    email: string | null;
    invitee_id: string | null;
    role_id: string;
    role_name: string;
    expires_at: string;
    accepted_at: string | null;
    workspace_name: string;
    workspace_icon: string | null;
    workspace_avatar_url: string | null;
    invited_by_name: string | null;
  }

  async function loadInvite(token: string): Promise<InviteRow> {
    const { rows } = await query<InviteRow>(
      `SELECT i.id, i.workspace_id, i.email, i.invitee_id, i.role_id, r.name AS role_name, i.expires_at, i.accepted_at,
              w.name AS workspace_name, w.icon AS workspace_icon,
              ${uploadUrlSql('w.avatar_key')} AS workspace_avatar_url, u.name AS invited_by_name
         FROM workspace_invites i
         JOIN workspaces w ON w.id = i.workspace_id
         JOIN workspace_roles r ON r.id = i.role_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token = $1`,
      [token],
    );
    const invite = rows[0];
    if (!invite) throw notFound('This invite link is not valid');
    if (invite.accepted_at) throw badRequest('This invite has already been used');
    if (new Date(invite.expires_at).getTime() < Date.now()) throw badRequest('This invite has expired');
    return invite;
  }

  // Readable while signed out, so the sign-in screen can name the workspace.
  app.get<{ Params: { token: string } }>('/invites/:token', async (req) => {
    const invite = await loadInvite(req.params.token);
    const alreadyMember = req.user
      ? (await workspaceMembership(req.user.id, invite.workspace_id)) !== null
      : false;
    return {
      workspaceName: invite.workspace_name,
      workspaceIcon: invite.workspace_icon,
      workspaceAvatarUrl: invite.workspace_avatar_url,
      role: invite.role_name,
      email: invite.email,
      invitedBy: invite.invited_by_name,
      expiresAt: invite.expires_at,
      alreadyMember,
    };
  });

  app.post<{ Params: { token: string } }>('/invites/:token/accept', async (req) => {
    if (!req.user) throw forbidden('Sign in to accept this invite');
    const invite = await loadInvite(req.params.token);

    // An invite for someone in particular is theirs alone: the account it was
    // sent to when it had one, otherwise the address, from its link.
    if (invite.invitee_id ? invite.invitee_id !== req.user.id : invite.email && invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
      throw forbidden(`This invite was sent to ${invite.email}`);
    }

    const { rows: existing } = await query<{ name: string }>(
      `SELECT r.name FROM workspace_members m JOIN workspace_roles r ON r.id = m.role_id
        WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [invite.workspace_id, req.user.id],
    );
    // The name of the role they hold, which is what they will be shown.
    if (existing[0]) return { workspaceId: invite.workspace_id, role: existing[0].name, alreadyMember: true };

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, role_id) VALUES ($1, $2, 'member', $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invite.workspace_id, req.user!.id, invite.role_id],
      );
      // Email invites are single use; link invites stay open until they expire.
      if (invite.email) {
        await client.query(
          'UPDATE workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
          [invite.id, req.user!.id],
        );
      }
    });

    membersChanged(invite.workspace_id);
    return { workspaceId: invite.workspace_id, role: invite.role_name, alreadyMember: false };
  });
};
