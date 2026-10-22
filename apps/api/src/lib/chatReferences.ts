import {
  MAX_WORK_ITEM_CHILDREN,
  collectReferences,
  type ChannelReference,
  type DocumentReference,
  type MemberReference,
  type MessageReferences,
  type PresentationReference,
  type ProjectReference,
  type ScheduleReference,
  type EpicProgress,
  type SpreadsheetReference,
  type StatusCategory,
  type WorkItemChild,
  type WorkItemDetail,
  type WorkItemReference,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import {
  channelLevelSql,
  documentLevelSql,
  presentationLevelSql,
  projectLevelSql,
  roleIdSql,
  scheduleLevelSql,
  spreadsheetLevelSql,
} from './access.js';
import { appEnabledSql } from './apps.js';

export type {
  ChannelReference,
  DocumentReference,
  MemberReference,
  MessageReferences,
  PresentationReference,
  ProjectReference,
  SpreadsheetReference,
  WorkItemReference,
};

/**
 * Resolves the `<doc:…>`, `<sheet:…>`, `<deck:…>`, `<item:…>`, `<proj:…>`, `<#…>` and `<@…>` tokens in
 * a batch of message bodies — or anything else written the same way, such as a
 * work item's description and comments.
 *
 * Sent alongside the messages so a page of chat renders its links in one round
 * trip. Everything is constrained to the workspace the channel belongs to: a
 * message body is user input, and an id pasted from elsewhere must not be able
 * to read back a title from a workspace the reader cannot see.
 *
 * Documents, spreadsheets and channels are also constrained to what the reader
 * may see, and to the apps the workspace has on, so a link to something locked
 * does not give away its title. With no reader — a
 * message pushed to everyone in a channel at once — only what is open to the
 * whole workspace is named, and each reader asks for the rest themselves.
 */
export async function resolveReferences(
  bodies: string[],
  workspaceId: string,
  viewerId: string | null,
): Promise<MessageReferences> {
  const { documentIds, spreadsheetIds, workItemIds, projectIds, scheduleIds, presentationIds, channelIds, userIds } =
    collectReferences(bodies);
  const empty: MessageReferences = { documents: [], spreadsheets: [], channels: [], members: [], workItems: [], projects: [], schedules: [], presentations: [] };
  if (
    documentIds.length === 0 &&
    spreadsheetIds.length === 0 &&
    workItemIds.length === 0 &&
    projectIds.length === 0 &&
    scheduleIds.length === 0 &&
    presentationIds.length === 0 &&
    channelIds.length === 0 &&
    userIds.length === 0
  ) {
    return empty;
  }

  const viewerRole = roleIdSql('$3', '$2');
  const viewer = viewerId ? [viewerId] : [];

  const [documents, spreadsheets, channels, members, workItems, projects, schedules, presentations] = await Promise.all([
    documentIds.length
      ? query<DocumentReference>(
          `SELECT d.id, d.title, d.icon, d.mode FROM documents d
            WHERE d.id = ANY($1::uuid[]) AND d.workspace_id = $2 AND ${appEnabledSql('$2', 'docs')}
              AND ${viewerId ? `${documentLevelSql('$3', viewerRole)} > 0` : 'document_is_open(d.access, d.folder_id)'}`,
          [documentIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    spreadsheetIds.length
      ? // Same workspace constraint as documents, for the same reason. An
        // archived sheet still resolves: the message linking it is history, and
        // a chip that goes blank when someone archives reads as a bug.
        query<SpreadsheetReference>(
          `SELECT s.id, s.title, s.icon FROM spreadsheets s
            WHERE s.id = ANY($1::uuid[]) AND s.workspace_id = $2 AND ${appEnabledSql('$2', 'sheets')}
              AND ${viewerId ? `${spreadsheetLevelSql('$3', viewerRole)} > 0` : 'document_is_open(s.access, s.folder_id)'}`,
          [spreadsheetIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    channelIds.length
      ? query<ChannelReference>(
          // A direct conversation has no name, and its existence is its own business.
          `SELECT c.id, c.name, c.kind FROM channels c
            WHERE c.id = ANY($1::uuid[]) AND c.workspace_id = $2 AND c.kind <> 'direct'
              AND ${viewerId ? `${channelLevelSql('$3', viewerRole)} > 0` : `c.access = 'open'`}`,
          [channelIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    userIds.length
      ? // Joined through membership, so mentioning an id from outside the
        // workspace resolves to nothing rather than disclosing who they are.
        query<MemberReference>(
          `SELECT u.id, u.name, u.email
             FROM users u
             JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $2
            WHERE u.id = ANY($1::uuid[])`,
          [userIds, workspaceId],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    workItemIds.length ? resolveWorkItems(workItemIds, workspaceId, viewerId) : Promise.resolve([]),
    projectIds.length
      ? // Held to what the reader may see, as work items are; an archived one
        // still resolves, since the link to it is history.
        query<ProjectReference>(
          `SELECT p.id, p.kind, p.key, p.name, p.icon FROM projects p
            WHERE p.id = ANY($1::uuid[]) AND p.workspace_id = $2 AND ${appEnabledSql('$2', 'projects')}
              AND ${viewerId ? `${projectLevelSql('$3', viewerRole)} > 0` : `p.access = 'open'`}`,
          [projectIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    scheduleIds.length
      ? // Held to what the reader may see, and gone with the app.
        query<ScheduleReference>(
          `SELECT s.id, s.name, s.color FROM schedules s
            WHERE s.id = ANY($1::uuid[]) AND s.workspace_id = $2 AND ${appEnabledSql('$2', 'schedules')}
              AND ${viewerId ? `${scheduleLevelSql('$3', viewerRole)} > 0` : `s.access = 'open'`}`,
          [scheduleIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    presentationIds.length
      ? // Held to what the reader may see, and gone with the app. An archived
        // deck still resolves: the link to it is history.
        query<PresentationReference>(
          `SELECT p.id, p.title, p.icon FROM presentations p
            WHERE p.id = ANY($1::uuid[]) AND p.workspace_id = $2 AND ${appEnabledSql('$2', 'slides')}
              AND ${viewerId ? `${presentationLevelSql('$3', viewerRole)} > 0` : 'document_is_open(p.access, p.folder_id)'}`,
          [presentationIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
  ]);

  return { documents, spreadsheets, channels, members, workItems, projects, schedules, presentations };
}

/**
 * Work items by id, held to one workspace and to what the reader may see, as
 * everything else here is. With no reader, only items in open projects.
 * Items in an archived project still resolve: the mention is history.
 */
export async function resolveWorkItems(
  ids: string[],
  workspaceId: string | null,
  viewerId: string | null,
): Promise<WorkItemReference[]> {
  if (ids.length === 0) return [];
  const viewerRole = roleIdSql('$3', 'p.workspace_id');
  const { rows } = await query<WorkItemReference>(
    `SELECT i.id, i.project_id AS "projectId", p.key || '-' || i.number AS key, i.title,
            st.name AS "statusName", st.category AS "statusCategory", st.color AS "statusColor"
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN project_statuses st ON st.id = i.status_id
      WHERE i.id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR i.workspace_id = $2)
        AND ${appEnabledSql('p.workspace_id', 'projects')}
        AND ${viewerId ? `${projectLevelSql('$3', viewerRole)} > 0` : `p.access = 'open'`}`,
    [ids, workspaceId, ...(viewerId ? [viewerId] : [])],
  );
  return rows;
}

/**
 * Work items in detail, for the status slides of a presentation: each item as
 * {@link resolveWorkItems} gives it, with who is on it, when it is due, and
 * how far the work under it has got. The same access rule applies, and the
 * work under an item is counted and listed only where the viewer may see it.
 */
export async function resolveWorkItemDetails(ids: string[], viewerId: string): Promise<WorkItemDetail[]> {
  if (ids.length === 0) return [];
  const viewerRole = roleIdSql('$2', 'p.workspace_id');
  const { rows } = await query<Omit<WorkItemDetail, 'progress' | 'children' | 'statuses'>>(
    `SELECT i.id, i.project_id AS "projectId", p.key || '-' || i.number AS key, i.title,
            st.name AS "statusName", st.category AS "statusCategory", st.color AS "statusColor",
            COALESCE(t.name, '') AS "typeName", COALESCE(t.epic, false) AS epic,
            to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
            COALESCE((
              SELECT json_agg(COALESCE(u.name, wr.name) ORDER BY wr.created_at)
                FROM work_item_roles wr
                LEFT JOIN users u ON u.id = wr.user_id
               WHERE wr.work_item_id = i.id
                 AND wr.role_id = (SELECT r.id FROM project_roles r
                                    WHERE r.project_id = i.project_id
                                    ORDER BY r.position, r.created_at LIMIT 1)
                 AND COALESCE(u.name, wr.name) IS NOT NULL
            ), '[]'::json) AS people
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN project_statuses st ON st.id = i.status_id
       LEFT JOIN project_item_types t ON t.id = i.type_id
      WHERE i.id = ANY($1::uuid[])
        AND ${appEnabledSql('p.workspace_id', 'projects')}
        AND ${projectLevelSql('$2', viewerRole)} > 0`,
    [ids, viewerId],
  );
  if (rows.length === 0) return [];

  const found = rows.map((row) => row.id);
  const childRole = roleIdSql('$2', 'cp.workspace_id');
  const [children, statuses, totals] = await Promise.all([
    query<WorkItemChild & { epicId: string; rank: number }>(
      `SELECT * FROM (
         SELECT c.epic_id AS "epicId", c.id, cp.key || '-' || c.number AS key, c.title,
                cs.name AS "statusName", cs.category AS "statusCategory", cs.color AS "statusColor",
                row_number() OVER (PARTITION BY c.epic_id ORDER BY (cs.category = 'done'), cs.position, c.position) AS rank
           FROM work_items c
           JOIN projects cp ON cp.id = c.project_id
           JOIN project_statuses cs ON cs.id = c.status_id
          WHERE c.epic_id = ANY($1::uuid[]) AND c.archived_at IS NULL
            AND ${projectLevelSql('$2', childRole, 'cp')} > 0
       ) ranked
       WHERE rank <= $3
       ORDER BY "epicId", rank`,
      [found, viewerId, MAX_WORK_ITEM_CHILDREN],
    ),
    query<{ epicId: string; name: string; color: string; category: StatusCategory; count: number }>(
      `SELECT c.epic_id AS "epicId", cs.name, cs.color, cs.category, count(*)::int AS count
         FROM work_items c
         JOIN projects cp ON cp.id = c.project_id
         JOIN project_statuses cs ON cs.id = c.status_id
        WHERE c.epic_id = ANY($1::uuid[])
          AND ${projectLevelSql('$2', childRole, 'cp')} > 0
        GROUP BY c.epic_id, cs.name, cs.color, cs.category
        ORDER BY c.epic_id, min(cs.position)`,
      [found, viewerId],
    ),
    // Archived work is always done, as epicProgress counts it.
    query<{ epicId: string } & EpicProgress>(
      `SELECT c.epic_id AS "epicId", count(*)::int AS total,
              count(*) FILTER (WHERE cs.category = 'done' OR c.archived_at IS NOT NULL)::int AS done,
              COALESCE(sum(c.estimate), 0)::float8 AS estimate,
              COALESCE(sum(c.estimate) FILTER (WHERE cs.category = 'done' OR c.archived_at IS NOT NULL), 0)::float8 AS "doneEstimate"
         FROM work_items c
         JOIN projects cp ON cp.id = c.project_id
         JOIN project_statuses cs ON cs.id = c.status_id
        WHERE c.epic_id = ANY($1::uuid[])
          AND ${projectLevelSql('$2', childRole, 'cp')} > 0
        GROUP BY c.epic_id`,
      [found, viewerId],
    ),
  ]);

  const progress = new Map(totals.rows.map(({ epicId, ...rest }) => [epicId, rest]));
  return rows.map((row) => ({
    ...row,
    progress: progress.get(row.id) ?? null,
    children: children.rows.filter((c) => c.epicId === row.id).map(({ epicId: _e, rank: _r, ...child }) => child),
    statuses: statuses.rows.filter((s) => s.epicId === row.id).map(({ name, color, category, count }) => ({ name, color, category, count })),
  }));
}
