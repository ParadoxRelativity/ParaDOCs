import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createInviteSchema, updateMemberSchema } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess, roleAtLeast, workspaceRole, type Role } from '../plugins/session.js';

/** Owners must never be able to remove the last owner from a workspace. */
async function countOwners(workspaceId: string): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workspace_members
      WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return rows[0].count;
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/workspaces/:id/members', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const { rows } = await query(
      `SELECT m.user_id AS "userId", u.name, u.email, m.role,
              m.created_at AS "joinedAt", (m.user_id = $2) AS "isSelf"
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
          lower(u.name)`,
      [req.params.id, req.user!.id],
    );
    return rows;
  });

  app.patch<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    async (req) => {
      const actorRole = await assertWorkspaceAccess(req, req.params.id, 'admin');
      const input = parse(updateMemberSchema, req.body);

      const target = await workspaceRole(req.params.userId, req.params.id);
      if (!target) throw notFound('That person is not a member of this workspace');

      // Admins cannot touch owners, and only owners can mint new owners.
      if (!roleAtLeast(actorRole, 'owner') && (target === 'owner' || input.role === 'owner')) {
        throw forbidden('Only an owner can change owner roles');
      }
      if (target === 'owner' && input.role !== 'owner' && (await countOwners(req.params.id)) <= 1) {
        throw badRequest('A workspace must keep at least one owner');
      }

      const { rows } = await query(
        `UPDATE workspace_members SET role = $3
          WHERE workspace_id = $1 AND user_id = $2
          RETURNING user_id AS "userId", role`,
        [req.params.id, req.params.userId, input.role],
      );
      return rows[0];
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/workspaces/:id/members/:userId',
    async (req, reply) => {
      const leaving = req.params.userId === req.user!.id;
      // Anyone may remove themselves; removing someone else needs admin.
      const actorRole = await assertWorkspaceAccess(req, req.params.id, leaving ? 'viewer' : 'admin');

      const target = await workspaceRole(req.params.userId, req.params.id);
      if (!target) throw notFound('That person is not a member of this workspace');
      if (!leaving && target === 'owner' && !roleAtLeast(actorRole, 'owner')) {
        throw forbidden('Only an owner can remove another owner');
      }
      if (target === 'owner' && (await countOwners(req.params.id)) <= 1) {
        throw badRequest('A workspace must keep at least one owner');
      }

      await query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
        req.params.id,
        req.params.userId,
      ]);
      reply.status(204);
    },
  );

  // --- invitations ---------------------------------------------------------

  app.get<{ Params: { id: string } }>('/workspaces/:id/invites', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const { rows } = await query(
      `SELECT i.id, i.workspace_id AS "workspaceId", i.email, i.role, i.token,
              i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt",
              i.created_at AS "createdAt", u.name AS "invitedBy"
         FROM workspace_invites i
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()
        ORDER BY i.created_at DESC`,
      [req.params.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/invites', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const input = parse(createInviteSchema, req.body ?? {});

    if (input.email) {
      const { rows } = await query(
        `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND lower(u.email) = lower($2)`,
        [req.params.id, input.email],
      );
      if (rows.length) throw conflict('That person is already a member of this workspace');
    }

    const token = randomBytes(24).toString('base64url');
    const { rows } = await query(
      `INSERT INTO workspace_invites (workspace_id, email, role, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING id, workspace_id AS "workspaceId", email, role, token,
                 expires_at AS "expiresAt", accepted_at AS "acceptedAt", created_at AS "createdAt"`,
      [
        req.params.id,
        input.email ?? null,
        input.role,
        token,
        req.user!.id,
        String(input.expiresInDays),
      ],
    );
    reply.status(201);
    return rows[0];
  });

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/workspaces/:id/invites/:inviteId',
    async (req, reply) => {
      await assertWorkspaceAccess(req, req.params.id, 'admin');
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
    role: Role;
    expires_at: string;
    accepted_at: string | null;
    workspace_name: string;
    workspace_icon: string | null;
    invited_by_name: string | null;
  }

  async function loadInvite(token: string): Promise<InviteRow> {
    const { rows } = await query<InviteRow>(
      `SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at,
              w.name AS workspace_name, w.icon AS workspace_icon, u.name AS invited_by_name
         FROM workspace_invites i
         JOIN workspaces w ON w.id = i.workspace_id
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
      ? (await workspaceRole(req.user.id, invite.workspace_id)) !== null
      : false;
    return {
      workspaceName: invite.workspace_name,
      workspaceIcon: invite.workspace_icon,
      role: invite.role,
      email: invite.email,
      invitedBy: invite.invited_by_name,
      expiresAt: invite.expires_at,
      alreadyMember,
    };
  });

  app.post<{ Params: { token: string } }>('/invites/:token/accept', async (req) => {
    if (!req.user) throw forbidden('Sign in to accept this invite');
    const invite = await loadInvite(req.params.token);

    // An invite addressed to a specific address may only be used by that address.
    if (invite.email && invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
      throw forbidden(`This invite was sent to ${invite.email}`);
    }

    const existing = await workspaceRole(req.user.id, invite.workspace_id);
    if (existing) return { workspaceId: invite.workspace_id, role: existing, alreadyMember: true };

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invite.workspace_id, req.user!.id, invite.role],
      );
      // Email invites are single use; link invites stay open until they expire.
      if (invite.email) {
        await client.query(
          'UPDATE workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
          [invite.id, req.user!.id],
        );
      }
    });

    return { workspaceId: invite.workspace_id, role: invite.role, alreadyMember: false };
  });
};
