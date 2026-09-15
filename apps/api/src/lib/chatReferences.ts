import {
  collectReferences,
  type ChannelReference,
  type DocumentReference,
  type MemberReference,
  type MessageReferences,
  type SpreadsheetReference,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { channelLevelSql, documentLevelSql, roleSql } from './access.js';

export type {
  ChannelReference,
  DocumentReference,
  MemberReference,
  MessageReferences,
  SpreadsheetReference,
};

/**
 * Resolves the `<doc:…>`, `<sheet:…>` and `<#…>` tokens in a batch of message
 * bodies.
 *
 * Sent alongside the messages so a page of chat renders its links in one round
 * trip. Everything is constrained to the workspace the channel belongs to: a
 * message body is user input, and an id pasted from elsewhere must not be able
 * to read back a title from a workspace the reader cannot see.
 *
 * Documents and channels are also constrained to what the reader may see, so a
 * link to something locked does not give away its title. With no reader — a
 * message pushed to everyone in a channel at once — only what is open to the
 * whole workspace is named, and each reader asks for the rest themselves.
 */
export async function resolveReferences(
  bodies: string[],
  workspaceId: string,
  viewerId: string | null,
): Promise<MessageReferences> {
  const { documentIds, spreadsheetIds, channelIds, userIds } = collectReferences(bodies);
  const empty: MessageReferences = { documents: [], spreadsheets: [], channels: [], members: [] };
  if (
    documentIds.length === 0 &&
    spreadsheetIds.length === 0 &&
    channelIds.length === 0 &&
    userIds.length === 0
  ) {
    return empty;
  }

  const viewerRole = roleSql('$3', '$2');
  const viewer = viewerId ? [viewerId] : [];

  const [documents, spreadsheets, channels, members] = await Promise.all([
    documentIds.length
      ? query<DocumentReference>(
          `SELECT d.id, d.title, d.icon, d.mode FROM documents d
            WHERE d.id = ANY($1::uuid[]) AND d.workspace_id = $2
              AND ${viewerId ? `${documentLevelSql('$3', viewerRole)} > 0` : 'document_is_open(d.access, d.folder_id)'}`,
          [documentIds, workspaceId, ...viewer],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    spreadsheetIds.length
      ? // Same workspace constraint as documents, for the same reason. An
        // archived sheet still resolves: the message linking it is history, and
        // a chip that goes blank when someone archives reads as a bug.
        query<SpreadsheetReference>(
          `SELECT id, title, icon FROM spreadsheets WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
          [spreadsheetIds, workspaceId],
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
  ]);

  return { documents, spreadsheets, channels, members };
}
