import type { FastifyRequest } from 'fastify';
import type { FolderApp, Permission, Role } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { appEnabledSql } from './apps.js';
import { forbidden, notFound, unauthorized } from './http.js';

/**
 * Who may reach a folder, document, spreadsheet or channel.
 *
 * The rules live in the database, as the functions migration 0014 adds, so one
 * query can list only what someone may see and every route asks the question
 * the same way. This is the TypeScript side: the SQL that calls them, and the
 * checks a route makes before acting on one thing.
 *
 * The database counts in levels — 0 nothing, 1 view, 2 edit — and the wire
 * speaks in permissions.
 *
 * Nothing here imports the session plugin, which imports this.
 */

export const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type Level = 0 | 1 | 2;

const PERMISSIONS: readonly Permission[] = ['none', 'view', 'edit'];

export function permissionOf(level: number): Permission {
  return PERMISSIONS[level] ?? 'none';
}

export function levelOf(permission: Permission): Level {
  return PERMISSIONS.indexOf(permission) as Level;
}

/** Owners and admins manage locks and teams, and no lock keeps them out. */
export function managesAccess(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/** SQL for someone's role in a workspace, for a query with no membership row to join. */
export function roleSql(user: string, workspace: string): string {
  return `(SELECT m.role FROM workspace_members m WHERE m.workspace_id = ${workspace} AND m.user_id = ${user})`;
}

/** SQL for what `user`, with `role`, may do with the document aliased `alias`. */
export function documentLevelSql(user: string, role: string, alias = 'd'): string {
  return `document_access_level(${user}, ${role}, ${alias}.access, ${alias}.id, ${alias}.folder_id)`;
}

/** SQL for what `user`, with `role`, may do with the spreadsheet aliased `alias`. */
export function spreadsheetLevelSql(user: string, role: string, alias = 's'): string {
  return `spreadsheet_access_level(${user}, ${role}, ${alias}.access, ${alias}.id, ${alias}.folder_id)`;
}

/** SQL for what `user`, with `role`, may do with the project aliased `alias`. */
export function projectLevelSql(user: string, role: string, alias = 'p'): string {
  return `project_access_level(${user}, ${role}, ${alias}.access, ${alias}.id)`;
}

/** SQL for what `user`, with `role`, may do in the folder `folder`. */
export function folderLevelSql(user: string, role: string, folder: string): string {
  return `folder_access_level(${user}, ${role}, ${folder})`;
}

/** SQL for what `user`, with `role`, may do in the named channel aliased `alias`. */
export function channelLevelSql(user: string, role: string, alias = 'c'): string {
  return `channel_access_level(${user}, ${role}, ${alias}.access, ${alias}.id)`;
}

/** SQL turning a level into 'none', 'view' or 'edit'. */
export function permissionSql(level: string): string {
  return `(ARRAY['none', 'view', 'edit'])[(${level}) + 1]`;
}

export interface ResourceAccess {
  workspaceId: string;
  role: Role;
  /** Never 0: something the person cannot see at all resolves to null instead. */
  level: Level;
}

/**
 * What someone may do with a document, or null when they may not see it — which
 * includes when the workspace has Docs turned off.
 */
export async function documentAccess(userId: string, documentId: string): Promise<ResourceAccess | null> {
  if (!UUID.test(documentId)) return null;
  const { rows } = await query<{ workspace_id: string; role: Role | null; level: number | null }>(
    `SELECT d.workspace_id, m.role, ${documentLevelSql('$2', 'm.role')} AS level
       FROM documents d
       LEFT JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = $2
      WHERE d.id = $1 AND ${appEnabledSql('d.workspace_id', 'docs')}`,
    [documentId, userId],
  );
  return resolved(rows[0]);
}

/** What someone may do with a spreadsheet, or null when they may not see it or Sheets is off. */
export async function spreadsheetAccess(userId: string, spreadsheetId: string): Promise<ResourceAccess | null> {
  if (!UUID.test(spreadsheetId)) return null;
  const { rows } = await query<{ workspace_id: string; role: Role | null; level: number | null }>(
    `SELECT s.workspace_id, m.role, ${spreadsheetLevelSql('$2', 'm.role')} AS level
       FROM spreadsheets s
       LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = $2
      WHERE s.id = $1 AND ${appEnabledSql('s.workspace_id', 'sheets')}`,
    [spreadsheetId, userId],
  );
  return resolved(rows[0]);
}

/** What someone may do with a project, or null when they may not see it or Projects is off. */
export async function projectAccess(userId: string, projectId: string): Promise<ResourceAccess | null> {
  if (!UUID.test(projectId)) return null;
  const { rows } = await query<{ workspace_id: string; role: Role | null; level: number | null }>(
    `SELECT p.workspace_id, m.role, ${projectLevelSql('$2', 'm.role')} AS level
       FROM projects p
       LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.id = $1 AND ${appEnabledSql('p.workspace_id', 'projects')}`,
    [projectId, userId],
  );
  return resolved(rows[0]);
}

export interface WorkItemAccess extends ResourceAccess {
  projectId: string;
}

/** What someone may do with a work item: whatever they may do with its project. */
export async function workItemAccess(userId: string, itemId: string): Promise<WorkItemAccess | null> {
  if (!UUID.test(itemId)) return null;
  const { rows } = await query<{ workspace_id: string; project_id: string; role: Role | null; level: number | null }>(
    `SELECT p.workspace_id, p.id AS project_id, m.role, ${projectLevelSql('$2', 'm.role')} AS level
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE i.id = $1 AND ${appEnabledSql('p.workspace_id', 'projects')}`,
    [itemId, userId],
  );
  const access = resolved(rows[0]);
  return access && { ...access, projectId: rows[0].project_id };
}

export interface FolderAccess extends ResourceAccess {
  app: FolderApp;
}

/** What someone may do in a folder, or null when they may not see it or its app is off. */
export async function folderAccess(userId: string, folderId: string): Promise<FolderAccess | null> {
  if (!UUID.test(folderId)) return null;
  const { rows } = await query<{ workspace_id: string; app: FolderApp; role: Role | null; level: number | null }>(
    `SELECT f.workspace_id, f.app, m.role, ${folderLevelSql('$2', 'm.role', 'f.id')} AS level
       FROM folders f
       LEFT JOIN workspace_members m ON m.workspace_id = f.workspace_id AND m.user_id = $2
      WHERE f.id = $1 AND workspace_app_enabled(f.workspace_id, f.app)`,
    [folderId, userId],
  );
  const access = resolved(rows[0]);
  return access && { ...access, app: rows[0].app };
}

function resolved(
  row: { workspace_id: string; role: Role | null; level: number | null } | undefined,
): ResourceAccess | null {
  if (!row?.role || !row.level) return null;
  return { workspaceId: row.workspace_id, role: row.role, level: row.level as Level };
}

/**
 * Resolves a folder and checks the caller may see it, or change what is in it.
 * One they may not see, one outside `workspaceId` or one in another app's tree
 * when those are given, is not found rather than forbidden, so a folder id
 * reveals nothing — and a document can never be filed among spreadsheets.
 */
export async function assertFolderAccess(
  req: FastifyRequest,
  folderId: string,
  need: 'view' | 'edit' = 'view',
  workspaceId?: string,
  app?: FolderApp,
): Promise<FolderAccess> {
  if (!req.user) throw unauthorized();
  const access = await folderAccess(req.user.id, folderId);
  if (!access || (workspaceId && access.workspaceId !== workspaceId) || (app && access.app !== app)) {
    throw notFound('Folder not found');
  }
  if (need === 'edit' && access.level < 2) {
    throw forbidden(
      access.role === 'viewer'
        ? 'This action requires the editor role or higher'
        : 'You can view this folder but not change what is in it',
    );
  }
  return access;
}

/**
 * Resolves a spreadsheet and checks what the caller may do with it, as
 * `assertFolderAccess` does for a folder. One they may not see is not found.
 */
export async function assertSpreadsheetAccess(
  req: FastifyRequest,
  spreadsheetId: string,
  need: 'view' | 'edit' = 'view',
): Promise<ResourceAccess> {
  if (!req.user) throw unauthorized();
  const access = await spreadsheetAccess(req.user.id, spreadsheetId);
  if (!access) throw notFound('Spreadsheet not found');
  if (need === 'edit' && access.level < 2) {
    throw forbidden(
      access.role === 'viewer'
        ? 'This action requires the editor role or higher'
        : 'You can view this spreadsheet but not change it',
    );
  }
  return access;
}

/** Resolves a project and checks what the caller may do with it. One they may not see is not found. */
export async function assertProjectAccess(
  req: FastifyRequest,
  projectId: string,
  need: 'view' | 'edit' = 'view',
): Promise<ResourceAccess> {
  if (!req.user) throw unauthorized();
  const access = await projectAccess(req.user.id, projectId);
  if (!access) throw notFound('Project not found');
  if (need === 'edit' && access.level < 2) {
    throw forbidden(
      access.role === 'viewer'
        ? 'This action requires the editor role or higher'
        : 'You can view this project but not change it',
    );
  }
  return access;
}

/** The same for a work item, which is governed by its project. */
export async function assertWorkItemAccess(
  req: FastifyRequest,
  itemId: string,
  need: 'view' | 'edit' = 'view',
): Promise<WorkItemAccess> {
  if (!req.user) throw unauthorized();
  const access = await workItemAccess(req.user.id, itemId);
  if (!access) throw notFound('Work item not found');
  if (need === 'edit' && access.level < 2) {
    throw forbidden(
      access.role === 'viewer'
        ? 'This action requires the editor role or higher'
        : 'You can view this project but not change it',
    );
  }
  return access;
}

/**
 * Refuses a move that would open something to the whole workspace: out from
 * under a locked folder and into a place no lock covers. Filing something into
 * a locked folder, or between locked ones, is ordinary filing. Opening
 * something up changes who can see it, and that is for owners and admins.
 *
 * `item` is the document, spreadsheet or folder being moved: its own setting, and the
 * folder it sits in now.
 */
export async function assertMoveKeepsAccess(
  role: Role,
  item: { access: string; folderId: string | null },
  toFolderId: string | null,
): Promise<void> {
  // Something with a setting of its own takes it along wherever it goes.
  if (managesAccess(role) || item.access !== 'inherit' || item.folderId === toFolderId) return;
  const { rows } = await query<{ opens: boolean }>(
    `SELECT COALESCE((SELECT access FROM folders WHERE id = access_folder_governor($1::uuid)), 'open') <> 'open'
        AND COALESCE((SELECT access FROM folders WHERE id = access_folder_governor($2::uuid)), 'open') = 'open'
            AS opens`,
    [item.folderId, toFolderId],
  );
  if (rows[0]?.opens) {
    throw forbidden('Moving it there would open it to everyone in the workspace. Ask an owner or admin to move it.');
  }
}
