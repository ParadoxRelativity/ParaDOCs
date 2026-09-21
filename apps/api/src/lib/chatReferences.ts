import {
  collectReferences,
  type ChannelReference,
  type DocumentReference,
  type MemberReference,
  type MessageReferences,
  type ProjectReference,
  type SpreadsheetReference,
  type WorkItemReference,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { channelLevelSql, documentLevelSql, projectLevelSql, roleSql, spreadsheetLevelSql } from './access.js';
import { appEnabledSql } from './apps.js';

export type {
  ChannelReference,
  DocumentReference,
  MemberReference,
  MessageReferences,
  ProjectReference,
  SpreadsheetReference,
  WorkItemReference,
};

/**
 * Resolves the `<doc:…>`, `<sheet:…>`, `<item:…>`, `<proj:…>`, `<#…>` and `<@…>` tokens in
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
  const { documentIds, spreadsheetIds, workItemIds, projectIds, channelIds, userIds } = collectReferences(bodies);
  const empty: MessageReferences = { documents: [], spreadsheets: [], channels: [], members: [], workItems: [], projects: [] };
  if (
    documentIds.length === 0 &&
    spreadsheetIds.length === 0 &&
    workItemIds.length === 0 &&
    projectIds.length === 0 &&
    channelIds.length === 0 &&
    userIds.length === 0
  ) {
    return empty;
  }

  const viewerRole = roleSql('$3', '$2');
  const viewer = viewerId ? [viewerId] : [];

  const [documents, spreadsheets, channels, members, workItems, projects] = await Promise.all([
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
  ]);

  return { documents, spreadsheets, channels, members, workItems, projects };
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
  const viewerRole = roleSql('$3', 'p.workspace_id');
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
