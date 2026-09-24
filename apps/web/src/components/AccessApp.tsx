import type { WorkspaceSummary } from '../api/hooks';
import { canFrom } from '../lib/permissions';
import MembersPanel from './MembersPanel';
import RolesPanel from './RolesPanel';
import TeamsPanel from './TeamsPanel';
import UploadsPanel from './UploadsPanel';
import WorkspaceAppsSettings from './WorkspaceAppsSettings';
import WorkspaceSettings from './WorkspaceSettings';

/** The pages of the Access app, each under its own name in the path. */
export const ACCESS_SECTIONS = ['members', 'teams', 'roles', 'workspace', 'apps', 'uploads'] as const;
export type AccessSection = (typeof ACCESS_SECTIONS)[number];

export function isAccessSection(value: string | undefined): value is AccessSection {
  return (ACCESS_SECTIONS as readonly (string | undefined)[]).includes(value);
}

export const ACCESS_TITLES: Record<AccessSection, string> = {
  members: 'Members',
  teams: 'Teams',
  roles: 'Roles',
  workspace: 'General',
  apps: 'Apps',
  uploads: 'Uploads',
};

/** Whether someone may manage the workspace: owners and admins. */
export function managesWorkspace(workspace: WorkspaceSummary): boolean {
  return workspace.role === 'owner' || workspace.role === 'admin';
}

/**
 * The Access app: everything about a workspace rather than what is in it — who
 * is in it and on which teams, its name and picture, which apps it uses, and
 * the files uploaded to it.
 *
 * It is named for what it governs rather than for who may change it. Everyone
 * can look at most of it, and owners and admins make the changes, which the
 * server holds them to — except where a role lets someone else invite people,
 * manage teams or look after uploads. Uploads is housekeeping, so only those
 * who may do it see it at all.
 */
export default function AccessApp({
  workspace,
  section,
  onWorkspaceDeleted,
  onOpenDocument,
}: {
  workspace: WorkspaceSummary;
  section: AccessSection;
  onWorkspaceDeleted: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const canManage = managesWorkspace(workspace);
  const can = canFrom(workspace.permissions);

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h1 className="mb-4 text-lg font-semibold">{ACCESS_TITLES[section]}</h1>
        {section === 'members' ? (
          <MembersPanel workspaceId={workspace.id} myRole={workspace.role} can={can} />
        ) : section === 'teams' ? (
          <TeamsPanel workspaceId={workspace.id} canManage={canManage} can={can} />
        ) : section === 'roles' ? (
          <RolesPanel workspaceId={workspace.id} canManage={canManage} />
        ) : section === 'workspace' ? (
          <WorkspaceSettings workspace={workspace} canManage={canManage} onDeleted={onWorkspaceDeleted} />
        ) : section === 'apps' ? (
          <WorkspaceAppsSettings workspace={workspace} canManage={canManage} />
        ) : can('uploads.manage') ? (
          <UploadsPanel workspaceId={workspace.id} onOpenDocument={onOpenDocument} />
        ) : (
          <p className="text-xs text-[var(--color-muted)]">Your role does not let you manage uploads.</p>
        )}
      </div>
    </div>
  );
}
