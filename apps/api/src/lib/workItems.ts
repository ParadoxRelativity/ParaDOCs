import { query } from '../db/pool.js';
import { publishToWorkspace } from '../chat/hub.js';
import { projectLevelSql } from './access.js';

/**
 * The parts of Projects that the rest of the server reaches into: recording
 * where work items are mentioned, telling people about the items that concern
 * them, and announcing that something in a project changed.
 */

export type MentionSource =
  | { kind: 'document'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'workItem'; id: string };

const SOURCE_COLUMN = { document: 'document_id', message: 'message_id', workItem: 'source_item_id' } as const;

/**
 * Makes the recorded mentions from one piece of content match what it says
 * now: items no longer mentioned are dropped and new ones added. Only items in
 * the same workspace count, so an id pasted from elsewhere records nothing.
 *
 * Called after the content itself is saved. A failure here loses a backlink,
 * never the content, so callers log it and carry on.
 */
export async function syncWorkItemMentions(
  source: MentionSource,
  workspaceId: string,
  itemIds: string[],
): Promise<void> {
  const column = SOURCE_COLUMN[source.kind];
  // An item does not mention itself in any way worth listing.
  const ids = [...new Set(itemIds)].filter((id) => id !== source.id);
  await query(
    `DELETE FROM work_item_mentions WHERE ${column} = $1 AND NOT (work_item_id = ANY($2::uuid[]))`,
    [source.id, ids],
  );
  if (ids.length === 0) return;
  await query(
    `INSERT INTO work_item_mentions (work_item_id, ${column})
     SELECT i.id, $1 FROM work_items i
      WHERE i.id = ANY($2::uuid[]) AND i.workspace_id = $3
     ON CONFLICT (source, work_item_id) DO NOTHING`,
    [source.id, ids, workspaceId],
  );
}

export type WorkItemNotificationReason = 'role' | 'mention' | 'comment' | 'status';

/**
 * How much a notification matters: being handed an item outranks being named
 * in it, and both outrank hearing that it moved on. An unread notification is
 * only replaced by one that matters as much or more.
 */
const RANK_SQL = (reason: string) => `CASE ${reason} WHEN 'role' THEN 3 WHEN 'mention' THEN 2 ELSE 1 END`;

/**
 * What an existing row becomes when another reason arrives for the same person
 * and item. One that matters less than an unread one leaves it as it was, time
 * and all: it is already waiting, and saying it again under someone else's name
 * would misreport who did what.
 */
const UPSERT_SQL = `
     ON CONFLICT (work_item_id, user_id) DO UPDATE
        SET reason = EXCLUDED.reason, detail = EXCLUDED.detail,
            created_by = EXCLUDED.created_by, created_at = now(), read_at = NULL
      WHERE work_item_notifications.read_at IS NOT NULL
         OR ${RANK_SQL('EXCLUDED.reason')} >= ${RANK_SQL('work_item_notifications.reason')}`;

/**
 * Tells people about a work item: that they were given a role on it, or named
 * in it. Only people who can open its project are told, and nobody is told
 * about their own doing. A new reason brings back a notification already read.
 */
export async function notifyAboutWorkItem(
  itemId: string,
  userIds: string[],
  reason: 'role' | 'mention',
  detail: string | null,
  by: string,
): Promise<void> {
  const candidates = [...new Set(userIds)].filter((id) => id !== by);
  if (candidates.length === 0) return;
  await query(
    `INSERT INTO work_item_notifications (work_item_id, user_id, reason, detail, created_by)
     SELECT i.id, m.user_id, $3, $4, $5
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN workspace_members m ON m.workspace_id = p.workspace_id
      WHERE i.id = $1
        AND m.user_id = ANY($2::uuid[])
        AND ${projectLevelSql('m.user_id', 'm.role_id')} > 0
     ${UPSERT_SQL}`,
    [itemId, candidates, reason, detail, by],
  );
}

/**
 * Tells everyone holding a role on a work item — whichever role, watcher
 * included — that it moved on: a comment, or a new status (`detail` names it).
 * As above, only people who can still open its project, and never the person
 * who did it.
 */
export async function notifyRoleHolders(
  itemId: string,
  reason: 'comment' | 'status',
  detail: string | null,
  by: string,
): Promise<void> {
  await query(
    `INSERT INTO work_item_notifications (work_item_id, user_id, reason, detail, created_by)
     SELECT DISTINCT i.id, m.user_id, $2, $3, $4::uuid
       FROM work_items i
       JOIN work_item_roles r ON r.work_item_id = i.id AND r.user_id IS NOT NULL
       JOIN projects p ON p.id = i.project_id
       JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = r.user_id
      WHERE i.id = $1
        AND m.user_id <> $4::uuid
        AND ${projectLevelSql('m.user_id', 'm.role_id')} > 0
     ${UPSERT_SQL}`,
    [itemId, reason, detail, by],
  );
}

/** Tells everyone with the workspace open that a project, or one of its items, changed. */
export function projectChanged(workspaceId: string, projectId: string, itemId?: string): void {
  publishToWorkspace(workspaceId, { type: 'projects.changed', workspaceId, projectId, itemId });
}
