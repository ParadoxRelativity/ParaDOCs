import { WORKSPACE_APPS, type WorkspaceApp } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { forbidden } from './http.js';

/**
 * Which apps a workspace has turned on.
 *
 * An app that is off is off on the server too, not only hidden in the sidebar:
 * its routes refuse, and what it holds stops resolving from anywhere else — a
 * link in chat, a reference in a document, a notification. Nothing is deleted,
 * so turning an app back on brings everything back as it was.
 *
 * Things looked up by id (a document, a channel, a spreadsheet) check this in
 * the same query that checks access, and are simply not found. Routes scoped to
 * a workspace say which app they belong to when they check membership.
 */

const LABELS: Record<WorkspaceApp, string> = { docs: 'Docs', sheets: 'Sheets', chat: 'Chat', projects: 'Projects' };

/** SQL for whether the workspace `workspace` has `app` turned on. */
export function appEnabledSql(workspace: string, app: WorkspaceApp): string {
  return `workspace_app_enabled(${workspace}, '${app}')`;
}

/** SQL turning a `disabled_apps` column into the apps that are on, in their usual order. */
export function enabledAppsSql(column: string): string {
  return `ARRAY(SELECT a FROM unnest(ARRAY[${WORKSPACE_APPS.map((app) => `'${app}'`).join(', ')}]::text[])
                  WITH ORDINALITY AS t(a, n)
                 WHERE NOT (a = ANY(${column})) ORDER BY n)`;
}

export async function appEnabled(workspaceId: string, app: WorkspaceApp): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean }>(`SELECT ${appEnabledSql('$1', app)} AS enabled`, [workspaceId]);
  return rows[0]?.enabled === true;
}

export async function assertAppEnabled(workspaceId: string, app: WorkspaceApp): Promise<void> {
  if (!(await appEnabled(workspaceId, app))) throw forbidden(`${LABELS[app]} is turned off in this workspace`);
}
