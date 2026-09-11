import {
  collectReferences,
  type ChannelReference,
  type DocumentReference,
  type MemberReference,
  type MessageReferences,
} from '@paradocs/shared';
import { query } from '../db/pool.js';

export type { ChannelReference, DocumentReference, MemberReference, MessageReferences };

/**
 * Resolves the `<doc:…>` and `<#…>` tokens in a batch of message bodies.
 *
 * Sent alongside the messages so a page of chat renders its links in one round
 * trip. Everything is constrained to the workspace the channel belongs to: a
 * message body is user input, and an id pasted from elsewhere must not be able
 * to read back a title from a workspace the reader cannot see.
 */
export async function resolveReferences(
  bodies: string[],
  workspaceId: string,
): Promise<MessageReferences> {
  const { documentIds, channelIds, userIds } = collectReferences(bodies);
  const empty: MessageReferences = { documents: [], channels: [], members: [] };
  if (documentIds.length === 0 && channelIds.length === 0 && userIds.length === 0) return empty;

  const [documents, channels, members] = await Promise.all([
    documentIds.length
      ? query<DocumentReference>(
          `SELECT id, title, icon, mode FROM documents WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
          [documentIds, workspaceId],
        ).then((r) => r.rows)
      : Promise.resolve([]),
    channelIds.length
      ? query<ChannelReference>(
          // A direct conversation has no name, and its existence is its own business.
          `SELECT id, name, kind FROM channels WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND kind <> 'direct'`,
          [channelIds, workspaceId],
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

  return { documents, channels, members };
}
