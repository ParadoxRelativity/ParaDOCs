/**
 * What a workspace role lets its members do.
 *
 * Owners and admins can do everything, and their roles cannot be changed. Every
 * other role is a set of the permissions below, which owners and admins choose.
 * A role is how far someone may go anywhere in the workspace; a lock on a
 * folder, document, channel or project can only narrow that for the teams and
 * people it names, never widen it.
 *
 * Some things stay with owners and admins whatever a role says: locks, roles,
 * who has which role, removing people, making, renaming and deleting teams,
 * the workspace's name, picture and apps, and getting past a workflow's rules.
 */

import type { ProjectKind } from './projects.js';

export const WORKSPACE_PERMISSIONS = [
  'docs.view',
  'docs.comment',
  'docs.edit',
  'docs.create',
  'docs.delete',
  'docs.tags',
  'docs.calendar',
  'sheets.view',
  'sheets.edit',
  'sheets.create',
  'sheets.delete',
  'chat.view',
  'chat.post',
  'chat.direct',
  'chat.channels',
  'chat.moderate',
  'projects.view',
  'projects.comment',
  'projects.items',
  'projects.sprints',
  'projects.create',
  'projects.configure',
  'projects.delete',
  'queues.view',
  'queues.comment',
  'queues.items',
  'queues.create',
  'queues.configure',
  'queues.delete',
  'members.invite',
  'teams.members',
  'uploads.manage',
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

export interface PermissionInfo {
  id: WorkspacePermission;
  label: string;
  description: string;
  /** Permissions this one is meaningless without. Saving a role adds them. */
  requires: WorkspacePermission[];
}

export interface PermissionGroup {
  id: 'docs' | 'sheets' | 'chat' | 'projects' | 'queues' | 'workspace';
  label: string;
  permissions: PermissionInfo[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'docs',
    label: 'Docs',
    permissions: [
      { id: 'docs.view', label: 'See documents', description: 'Read documents, folders and the calendar.', requires: [] },
      { id: 'docs.comment', label: 'Comment', description: 'Comment on documents they can see.', requires: ['docs.view'] },
      {
        id: 'docs.edit',
        label: 'Edit documents',
        description: 'Change documents and folders: their content, names, tags and where they are filed.',
        requires: ['docs.view'],
      },
      { id: 'docs.create', label: 'Create documents', description: 'Add documents and folders.', requires: ['docs.edit'] },
      { id: 'docs.delete', label: 'Delete documents', description: 'Delete documents and folders.', requires: ['docs.edit'] },
      { id: 'docs.tags', label: 'Manage tags', description: 'Create, rename and delete tags.', requires: ['docs.view'] },
      { id: 'docs.calendar', label: 'Edit the calendar', description: 'Add, change and remove calendar events.', requires: ['docs.view'] },
    ],
  },
  {
    id: 'sheets',
    label: 'Sheets',
    permissions: [
      { id: 'sheets.view', label: 'See spreadsheets', description: 'Open spreadsheets and their folders.', requires: [] },
      {
        id: 'sheets.edit',
        label: 'Edit spreadsheets',
        description: 'Change spreadsheets and folders, and where they are filed.',
        requires: ['sheets.view'],
      },
      { id: 'sheets.create', label: 'Create spreadsheets', description: 'Add spreadsheets and folders.', requires: ['sheets.edit'] },
      { id: 'sheets.delete', label: 'Delete spreadsheets', description: 'Delete spreadsheets and folders.', requires: ['sheets.edit'] },
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    permissions: [
      { id: 'chat.view', label: 'Read chat', description: 'Read channels and listen in on calls.', requires: [] },
      {
        id: 'chat.post',
        label: 'Post',
        description: 'Post, react and share files in channels and conversations, and speak in calls.',
        requires: ['chat.view'],
      },
      {
        id: 'chat.direct',
        label: 'Start conversations',
        description: 'Start direct and group conversations.',
        requires: ['chat.post'],
      },
      { id: 'chat.channels', label: 'Manage channels', description: 'Create, rename and delete channels.', requires: ['chat.view'] },
      { id: 'chat.moderate', label: 'Moderate', description: "Delete other people's messages in channels.", requires: ['chat.view'] },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    permissions: [
      { id: 'projects.view', label: 'See projects', description: 'See projects and their work items.', requires: [] },
      { id: 'projects.comment', label: 'Comment', description: 'Comment on work items.', requires: ['projects.view'] },
      {
        id: 'projects.items',
        label: 'Work on items',
        description: 'Create, edit, move and delete work items, with their links, files and people.',
        requires: ['projects.view'],
      },
      { id: 'projects.sprints', label: 'Run sprints', description: 'Plan, start and complete sprints.', requires: ['projects.items'] },
      {
        id: 'projects.configure',
        label: 'Configure projects',
        description: 'Change project settings, statuses, workflows, types and roles, and archive projects.',
        requires: ['projects.items'],
      },
      {
        id: 'projects.create',
        label: 'Create projects',
        description: 'Start new projects, and delete the ones they started.',
        requires: ['projects.configure'],
      },
      { id: 'projects.delete', label: 'Delete any project', description: 'Delete projects someone else started.', requires: ['projects.configure'] },
    ],
  },
  {
    id: 'queues',
    label: 'Queues',
    permissions: [
      { id: 'queues.view', label: 'See queues', description: 'See queues and their requests.', requires: [] },
      { id: 'queues.comment', label: 'Comment', description: 'Comment on requests.', requires: ['queues.view'] },
      {
        id: 'queues.items',
        label: 'Work on requests',
        description: 'Create, edit, move and delete requests, with their links, files and people.',
        requires: ['queues.view'],
      },
      {
        id: 'queues.configure',
        label: 'Configure queues',
        description: 'Change queue settings, statuses, workflows, types and roles, and archive queues.',
        requires: ['queues.items'],
      },
      {
        id: 'queues.create',
        label: 'Create queues',
        description: 'Start new queues, and delete the ones they started.',
        requires: ['queues.configure'],
      },
      { id: 'queues.delete', label: 'Delete any queue', description: 'Delete queues someone else started.', requires: ['queues.configure'] },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    permissions: [
      {
        id: 'members.invite',
        label: 'Invite people',
        description: 'Invite people and revoke invites, with a role no broader than their own.',
        requires: [],
      },
      {
        id: 'teams.members',
        label: 'Manage team members',
        description:
          'Add and remove other people on the teams they are on. Never themselves, and never on a team they are not on.',
        requires: [],
      },
      { id: 'uploads.manage', label: 'Manage uploads', description: 'See every uploaded file and clean up unused ones.', requires: [] },
    ],
  },
];

const INFO = new Map(PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => [p.id, p] as const)));

export function permissionInfo(permission: WorkspacePermission): PermissionInfo {
  return INFO.get(permission)!;
}

/**
 * A set of permissions with everything they need added, in catalog order, so
 * a role never holds one it could not use.
 */
export function withPrerequisites(permissions: Iterable<WorkspacePermission>): WorkspacePermission[] {
  const held = new Set<WorkspacePermission>();
  const add = (permission: WorkspacePermission) => {
    if (held.has(permission)) return;
    held.add(permission);
    INFO.get(permission)?.requires.forEach(add);
  };
  for (const permission of permissions) add(permission);
  return WORKSPACE_PERMISSIONS.filter((p) => held.has(p));
}

/**
 * The permissions that depend on this one, directly or not, which go when it
 * does.
 */
export function dependentsOf(permission: WorkspacePermission): WorkspacePermission[] {
  return WORKSPACE_PERMISSIONS.filter(
    (other) => other !== permission && withPrerequisites([other]).includes(permission),
  );
}

/** What the built-in Editor role starts with: today's editor. */
export const EDITOR_PERMISSIONS: WorkspacePermission[] = WORKSPACE_PERMISSIONS.filter(
  (p) =>
    !['chat.channels', 'chat.moderate', 'projects.delete', 'queues.delete', 'members.invite', 'teams.members', 'uploads.manage'].includes(p),
);

/** What the built-in Viewer role starts with: read everything, comment on documents, talk in chat. */
export const VIEWER_PERMISSIONS: WorkspacePermission[] = [
  'docs.view',
  'docs.comment',
  'sheets.view',
  'chat.view',
  'chat.post',
  'chat.direct',
  'projects.view',
  'queues.view',
];

/** Something done in a project or a queue. */
export type ProjectAction = 'view' | 'comment' | 'items' | 'sprints' | 'create' | 'configure' | 'delete';

/**
 * The permission for doing `action` in a project or a queue, which are held
 * separately. A queue has no sprints, so the question never comes up there;
 * working on its requests stands in.
 */
export function projectPermission(kind: ProjectKind, action: ProjectAction): WorkspacePermission {
  if (kind === 'queue' && action === 'sprints') return 'queues.items';
  return `${kind === 'queue' ? 'queues' : 'projects'}.${action}` as WorkspacePermission;
}

/**
 * Whether someone may put `userId` on a team, or take them off it.
 *
 * A team named on a lock lets its members in, or keeps them out, so who is on
 * one is who gets what the lock gives. Owners and admins change any team,
 * themselves included. Anyone else needs `teams.members`, and even then only
 * for teams they are on themselves, and never their own place: joining a team
 * on an allow list, or leaving one on a deny list, would reach past what the
 * lock was set up to give them.
 */
export function mayChangeTeamMember(
  actor: { id: string; manages: boolean; can: (permission: WorkspacePermission) => boolean },
  teamMemberIds: readonly string[],
  userId: string,
): boolean {
  if (actor.manages) return true;
  return actor.can('teams.members') && userId !== actor.id && teamMemberIds.includes(actor.id);
}
