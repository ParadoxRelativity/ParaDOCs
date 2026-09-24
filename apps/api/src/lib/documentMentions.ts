import { blockMentions, canvasMentions, type CanvasElement } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { documentLevelSql } from './access.js';

/**
 * Telling people they have been tagged.
 *
 * The tag lives in the content; this is only the record of who has been told
 * about it. It is written from the collaboration server's save, which is the
 * one place that sees every change to a document whichever surface made it.
 *
 * Two rules keep it honest. Someone is only told if they can actually open the
 * document — a tag is a pointer, and a pointer to something you cannot read is
 * worse than nothing. And nobody is told about tagging themselves, which is
 * common when writing a note about your own work.
 */

/** Names in a document body. */
export function mentionsInBlocks(body: unknown): string[] {
  return blockMentions(body);
}

/** Names anywhere on a canvas. */
export function mentionsInCanvas(elements: CanvasElement[]): string[] {
  return canvasMentions(elements);
}

/**
 * Records the people newly tagged in a document. Already-recorded tags are left
 * alone, including ones already read: being named a second time in a document
 * someone has already opened is not worth interrupting them for again.
 */
export async function recordMentions(
  documentId: string,
  userIds: string[],
  taggedBy: string | null,
): Promise<void> {
  const candidates = userIds.filter((id) => id !== taggedBy);
  if (candidates.length === 0) return;

  await query(
    `INSERT INTO document_mentions (document_id, user_id, created_by)
     SELECT d.id, m.user_id, $3
       FROM documents d
       JOIN workspace_members m ON m.workspace_id = d.workspace_id
      WHERE d.id = $1
        AND m.user_id = ANY($2::uuid[])
        AND ${documentLevelSql('m.user_id', 'm.role_id')} > 0
     ON CONFLICT (document_id, user_id) DO NOTHING`,
    [documentId, candidates, taggedBy],
  );
}

/**
 * The display names of the people tagged on a canvas, so its search text can
 * say "@Ada Lovelace" where the board stores only an id.
 */
export async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { rows } = await query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = ANY($1::uuid[])',
    [userIds],
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}
