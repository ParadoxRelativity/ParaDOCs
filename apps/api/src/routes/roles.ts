import type { FastifyPluginAsync } from 'fastify';
import { createWorkspaceRoleSchema, updateWorkspaceRoleSchema, withPrerequisites } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { UUID } from '../lib/access.js';
import { accessChanged } from '../lib/accessEvents.js';
import { assertRoleNameFree, fetchRole, listRoles, loadRole } from '../lib/workspaceRoles.js';
import { publishToWorkspace } from '../chat/hub.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * A workspace's roles: what each lets its members do. See migration 0031.
 *
 * Everyone may see the roles, so they know what the names beside people mean.
 * Only owners and admins change them, and nobody changes Owner or Admin.
 */

/** What someone may do follows their role, so a changed role is changed access. */
function rolesChanged(workspaceId: string): void {
  // The client keeps roles under the members key, so this refreshes both, and
  // each person's own permissions come with the workspace list it also refreshes.
  publishToWorkspace(workspaceId, { type: 'members.changed', workspaceId });
  accessChanged(workspaceId);
}

async function roleWorkspace(roleId: string): Promise<string> {
  if (!UUID.test(roleId)) throw notFound('Role not found');
  const { rows } = await query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_roles WHERE id = $1', [roleId]);
  if (!rows[0]) throw notFound('Role not found');
  return rows[0].workspace_id;
}

export const roleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/workspaces/:id/roles', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    return listRoles(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/roles', async (req, reply) => {
    const workspaceId = req.params.id;
    await assertWorkspaceAccess(req, workspaceId, 'manage');
    const input = parse(createWorkspaceRoleSchema, req.body);
    await assertRoleNameFree(workspaceId, input.name);

    let permissions = input.permissions ?? [];
    if (input.copyFrom && permissions.length === 0) {
      const source = await loadRole(workspaceId, input.copyFrom);
      // Copying Owner or Admin gives everything that can be given.
      permissions = source.system ? (await fetchRole(source.id)).permissions : source.permissions;
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM workspace_roles WHERE workspace_id = $1))
       RETURNING id`,
      [workspaceId, input.name, input.description, withPrerequisites(permissions)],
    );
    rolesChanged(workspaceId);
    reply.status(201);
    return fetchRole(rows[0].id);
  });

  app.patch<{ Params: { id: string } }>('/workspace-roles/:id', async (req) => {
    const workspaceId = await roleWorkspace(req.params.id);
    await assertWorkspaceAccess(req, workspaceId, 'manage');
    const input = parse(updateWorkspaceRoleSchema, req.body);
    const role = await loadRole(workspaceId, req.params.id);

    if (
      role.system &&
      (input.name !== undefined || input.description !== undefined || input.permissions !== undefined || input.position !== undefined)
    ) {
      throw badRequest(`The ${role.name} role is built in and cannot be changed`);
    }
    if (role.system && input.isDefault) {
      throw badRequest(`New invites cannot start as ${role.name}. Choose a role that is not built in.`);
    }
    if (input.name !== undefined) await assertRoleNameFree(workspaceId, input.name, role.id);

    await transaction(async (client) => {
      await client.query(
        `UPDATE workspace_roles
            SET name = COALESCE($2, name),
                description = COALESCE($3, description),
                permissions = COALESCE($4, permissions)
          WHERE id = $1`,
        [
          role.id,
          input.name ?? null,
          input.description ?? null,
          input.permissions ? withPrerequisites(input.permissions) : null,
        ],
      );
      if (input.isDefault) {
        await client.query('UPDATE workspaces SET default_role_id = $2 WHERE id = $1', [workspaceId, role.id]);
      }
      if (input.position !== undefined) {
        // `position` counts among the roles that are not built in, which
        // always come after Owner (0) and Admin (1).
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system IS NULL ORDER BY position, lower(name)',
          [workspaceId],
        );
        const order = rows.map((r) => r.id).filter((id) => id !== role.id);
        order.splice(Math.min(input.position, order.length), 0, role.id);
        await client.query(
          `UPDATE workspace_roles r SET position = t.n + 1
             FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, n) WHERE r.id = t.id`,
          [order],
        );
      }
    });
    rolesChanged(workspaceId);
    return fetchRole(role.id);
  });

  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>('/workspace-roles/:id', async (req, reply) => {
    const workspaceId = await roleWorkspace(req.params.id);
    await assertWorkspaceAccess(req, workspaceId, 'manage');
    const role = await fetchRole(req.params.id);
    if (role.system) throw badRequest(`The ${role.name} role is built in and cannot be deleted`);

    const target = req.query.moveTo ? await loadRole(workspaceId, req.query.moveTo) : null;
    if (target?.id === role.id) throw badRequest('Choose another role to move everyone to');
    if (target?.system === 'owner') throw badRequest('Nobody can be moved to Owner this way. An owner makes owners one at a time.');
    if (role.isDefault && target?.system) throw badRequest('New invites start with this role. Choose a role that is not built in.');
    if ((role.memberCount > 0 || role.inviteCount > 0 || role.isDefault) && !target) {
      throw badRequest(
        role.isDefault
          ? 'New invites start with this role. Choose the role to use instead.'
          : 'Choose a role for the people and invites that have this one',
      );
    }

    await transaction(async (client) => {
      if (target) {
        await client.query('UPDATE workspace_members SET role_id = $2 WHERE role_id = $1', [role.id, target.id]);
        // Invites that have expired or been used go with the role.
        await client.query(
          'DELETE FROM workspace_invites WHERE role_id = $1 AND (accepted_at IS NOT NULL OR expires_at <= now())',
          [role.id],
        );
        await client.query('UPDATE workspace_invites SET role_id = $2 WHERE role_id = $1', [role.id, target.id]);
        if (role.isDefault) {
          await client.query('UPDATE workspaces SET default_role_id = $2 WHERE id = $1', [workspaceId, target.id]);
        }
      } else {
        await client.query('DELETE FROM workspace_invites WHERE role_id = $1', [role.id]);
      }
      await client.query('DELETE FROM workspace_roles WHERE id = $1', [role.id]);
    });
    rolesChanged(workspaceId);
    reply.status(204);
  });
};
