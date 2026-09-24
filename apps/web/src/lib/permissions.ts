import {
  EDITOR_PERMISSIONS,
  mayChangeTeamMember,
  VIEWER_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  type Role,
  type Team,
  type WorkspaceApp,
  type WorkspacePermission,
} from '@paradocs/shared';

/**
 * What the signed-in person's role lets them do in a workspace, for deciding
 * which controls to show. The server holds them to it either way; this only
 * keeps the app from offering what would be refused.
 */
export type Can = (permission: WorkspacePermission) => boolean;

export const CANNOT: Can = () => false;

export function canFrom(permissions: readonly WorkspacePermission[] | undefined): Can {
  if (!permissions) return CANNOT;
  const held = new Set(permissions);
  return (permission) => held.has(permission);
}

/**
 * Whether the viewer may put someone on a team or take them off it: owners and
 * admins anywhere, and with `teams.members` only other people, on teams they
 * are on themselves. The server holds them to the same rule.
 */
export type MayChangeTeam = (team: Pick<Team, 'memberIds'>, userId: string) => boolean;

export function teamChanger(selfId: string | undefined, manages: boolean, can: Can): MayChangeTeam {
  return (team, userId) => selfId !== undefined && mayChangeTeamMember({ id: selfId, manages, can }, team.memberIds, userId);
}

/** Whether a role reaches an app at all. Projects holds both projects and queues. */
export function seesApp(can: Can, app: WorkspaceApp): boolean {
  if (app === 'projects') return can('projects.view') || can('queues.view');
  return can(`${app}.view`);
}

/** A role's key, from a server from before roles could be configured, as a name. */
export function roleName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * A workspace as a server from before roles could be configured describes it,
 * with only `role`, brought up to date: its four fixed roles were what Owner,
 * Admin, Editor and Viewer start as now.
 */
export function withPermissions<T extends { role: string; permissions?: WorkspacePermission[] }>(
  workspace: T,
): T & { role: Role; permissions: WorkspacePermission[] } {
  if (workspace.permissions) return workspace as T & { role: Role; permissions: WorkspacePermission[] };
  const legacy = workspace.role;
  const permissions =
    legacy === 'owner' || legacy === 'admin'
      ? [...WORKSPACE_PERMISSIONS]
      : legacy === 'editor'
        ? EDITOR_PERMISSIONS
        : VIEWER_PERMISSIONS;
  return {
    ...workspace,
    role: legacy === 'owner' || legacy === 'admin' ? legacy : 'member',
    permissions,
  };
}
