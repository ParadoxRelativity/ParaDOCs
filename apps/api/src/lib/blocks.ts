import { query } from '../db/pool.js';

/**
 * Blocking (see migration 0041): what someone blocked is kept from showing up
 * for the person who blocked them, and how the two may still reach each other.
 */

/**
 * A condition on `m.author_id`: the message is not from someone this user
 * blocked. Unread counts, mentions and notifications leave such messages out,
 * so a blocked person cannot ring a bell; the messages themselves still load,
 * and the client folds them away.
 */
export function notBlockedAuthorSql(userParam: string, authorColumn = 'm.author_id'): string {
  return `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ${userParam} AND ub.blocked_id = ${authorColumn})`;
}

/**
 * How a block stands between two people, if one does: `blocked` when `userId`
 * blocked `otherId`, `blockedBy` when the other way round. Either is enough to
 * stop a conversation between just the two of them.
 */
export async function blockBetween(userId: string, otherId: string): Promise<'blocked' | 'blockedBy' | null> {
  const { rows } = await query<{ blocker_id: string }>(
    `SELECT blocker_id FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [userId, otherId],
  );
  if (rows.some((r) => r.blocker_id === userId)) return 'blocked';
  return rows.length > 0 ? 'blockedBy' : null;
}

/** Of these people, the ones who blocked `userId`. */
export async function blockedBy(userId: string, people: string[]): Promise<Set<string>> {
  if (people.length === 0) return new Set();
  const { rows } = await query<{ blocker_id: string }>(
    'SELECT blocker_id FROM user_blocks WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])',
    [userId, people],
  );
  return new Set(rows.map((r) => r.blocker_id));
}
