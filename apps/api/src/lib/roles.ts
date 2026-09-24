import {
  WORKSPACE_PERMISSIONS,
  permissionInfo,
  type Role,
  type WorkspacePermission,
} from '@paradocs/shared';

/**
 * Someone's place in a workspace: whether they are an owner, an admin or a
 * member, which role they hold, and what it lets them do. See migration 0031.
 *
 * Nothing here touches the database or the session plugin, so both can use it.
 */
export interface Membership {
  role: Role;
  roleId: string;
  /** Everything, for an owner or admin. */
  permissions: ReadonlySet<WorkspacePermission>;
}

const EVERYTHING: ReadonlySet<WorkspacePermission> = new Set(WORKSPACE_PERMISSIONS);

/** A membership from a row carrying `role`, `role_id` and the role's `permissions`. */
export function membershipFrom(row: { role: Role; role_id: string; permissions: string[] | null }): Membership {
  return {
    role: row.role,
    roleId: row.role_id,
    permissions: row.role === 'member' ? new Set(row.permissions as WorkspacePermission[]) : EVERYTHING,
  };
}

/** SQL columns for `membershipFrom`, given a workspace_members alias `m` joined to workspace_roles `r`. */
export const MEMBERSHIP_COLUMNS = 'm.role, m.role_id, r.permissions';

/** Owners and admins manage the workspace, and no lock keeps them out. */
export function managesAccess(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

export function grants(member: Pick<Membership, 'permissions'>, permission: WorkspacePermission): boolean {
  return member.permissions.has(permission);
}

/** Why someone was refused, in the words the role editor uses. */
export function missingPermission(permission: WorkspacePermission): string {
  return `Your role does not let you ${permissionInfo(permission).label.toLowerCase()}`;
}

/** The permissions, in catalog order, for the wire. */
export function permissionList(member: Pick<Membership, 'permissions'>): WorkspacePermission[] {
  return WORKSPACE_PERMISSIONS.filter((p) => member.permissions.has(p));
}
