import { WORKSPACE_PERMISSIONS, type WorkspacePermission, type WorkspaceRole } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { conflict, forbidden, notFound } from './http.js';
import { UUID } from './access.js';
import { managesAccess, type Membership } from './roles.js';

/** A workspace role as the routes handle it. */
export interface RoleRow {
  id: string;
  workspaceId: string;
  name: string;
  system: 'owner' | 'admin' | null;
  permissions: WorkspacePermission[];
}

/** One of a workspace's roles, or 404 for any other id. */
export async function loadRole(workspaceId: string, roleId: string): Promise<RoleRow> {
  if (!UUID.test(roleId)) throw notFound('Role not found');
  const { rows } = await query<RoleRow>(
    `SELECT id, workspace_id AS "workspaceId", name, system, permissions
       FROM workspace_roles WHERE id = $1 AND workspace_id = $2`,
    [roleId, workspaceId],
  );
  if (!rows[0]) throw notFound('Role not found');
  return rows[0];
}

/**
 * Refuses to let someone hand out a role that would let its holder do more
 * than they can: an owner or admin may give any role (and only an owner makes
 * owners, which the member routes hold to), anyone else only one whose
 * permissions are all theirs too.
 */
export function assertMayGrant(actor: Membership, role: Pick<RoleRow, 'system' | 'permissions'>): void {
  if (managesAccess(actor.role)) return;
  if (role.system || role.permissions.some((p) => !actor.permissions.has(p))) {
    throw forbidden('You can only give out a role that allows no more than your own');
  }
}

const ROLE_COLUMNS = `r.id, r.workspace_id AS "workspaceId", r.name, r.description, r.system,
  CASE WHEN r.system IS NULL THEN r.permissions ELSE $2::text[] END AS permissions,
  (w.default_role_id = r.id) AS "isDefault",
  (SELECT count(*)::int FROM workspace_members m WHERE m.role_id = r.id) AS "memberCount",
  (SELECT count(*)::int FROM workspace_invites i
    WHERE i.role_id = r.id AND i.accepted_at IS NULL AND i.expires_at > now()) AS "inviteCount",
  r.position`;

/** Every role in a workspace, in the order they are shown. */
export async function listRoles(workspaceId: string): Promise<WorkspaceRole[]> {
  const { rows } = await query<WorkspaceRole>(
    `SELECT ${ROLE_COLUMNS}
       FROM workspace_roles r JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.workspace_id = $1
      ORDER BY r.position, lower(r.name)`,
    [workspaceId, WORKSPACE_PERMISSIONS],
  );
  return rows;
}

export async function fetchRole(roleId: string): Promise<WorkspaceRole> {
  const { rows } = await query<WorkspaceRole>(
    `SELECT ${ROLE_COLUMNS} FROM workspace_roles r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = $1`,
    [roleId, WORKSPACE_PERMISSIONS],
  );
  if (!rows[0]) throw notFound('Role not found');
  return rows[0];
}

/** Refuses a name another role in the workspace already has. */
export async function assertRoleNameFree(workspaceId: string, name: string, exceptId?: string): Promise<void> {
  const { rows } = await query(
    'SELECT 1 FROM workspace_roles WHERE workspace_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [workspaceId, name, exceptId ?? null],
  );
  if (rows.length) throw conflict(`There is already a role called ${name}`);
}
