import { textMembers } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { publishToUser } from '../chat/hub.js';
import { presentationLevelSql } from './access.js';

/**
 * Telling people they were named in a comment on a slide.
 *
 * The comment holds the tag (`<@uuid>`, as in chat); this is the record of who
 * has been told. As for documents, someone is only told if they can open the
 * presentation, and nobody is told about naming themselves. A person named
 * again in a later comment on the same slide is told again, since it is a new
 * thing to read.
 */
export async function recordSlideMentions(
  comment: { id: string; presentationId: string; slideId: string; body: string },
  taggedBy: string,
): Promise<void> {
  const candidates = textMembers([comment.body]).filter((id) => id !== taggedBy);
  if (candidates.length === 0) return;
  const { rows } = await query<{ user_id: string }>(
    `INSERT INTO slide_comment_mentions (comment_id, presentation_id, slide_id, user_id, created_by)
     SELECT $1, p.id, $3, m.user_id, $5
       FROM presentations p
       JOIN workspace_members m ON m.workspace_id = p.workspace_id
      WHERE p.id = $2
        AND m.user_id = ANY($4::uuid[])
        AND ${presentationLevelSql('m.user_id', 'm.role_id')} > 0
     ON CONFLICT (comment_id, user_id) DO NOTHING
     RETURNING user_id`,
    [comment.id, comment.presentationId, comment.slideId, candidates, taggedBy],
  );
  for (const row of rows) publishToUser(row.user_id, { type: 'notifications.changed' });
}
