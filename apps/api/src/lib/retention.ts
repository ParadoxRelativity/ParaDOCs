import type { FastifyBaseLogger } from 'fastify';
import { query } from '../db/pool.js';
import { getServerSettings } from './serverSettings.js';
import { removeStoredFiles } from './storage.js';

/** Deleted per statement, so a first sweep over years of history never holds one long lock. */
const BATCH = 1000;

let running = false;

/**
 * Permanently deletes messages in text channels older than the server's
 * retention maximum, with their files. Reactions and attachment rows cascade;
 * the files on disk are collected in the same statement and removed after.
 *
 * Direct messages are left alone. Nothing is announced to open clients: a
 * message this old is rarely on anyone's screen, and it is gone on next load.
 */
export async function sweepExpiredMessages(log: FastifyBaseLogger): Promise<number> {
  // The hourly timer and a settings change can both start a sweep.
  if (running) return 0;
  running = true;
  try {
    const { messageRetentionMaxDays: days } = await getServerSettings();
    if (!days) return 0;

    let total = 0;
    for (;;) {
      // Every part of a data-modifying WITH sees the same snapshot, so `files`
      // still finds the attachments the DELETE is about to cascade away.
      const { rows } = await query<{ deleted: number; keys: string[] }>(
        `WITH doomed AS (
           SELECT m.id FROM messages m
             JOIN channels c ON c.id = m.channel_id
            WHERE c.kind = 'text' AND m.created_at < now() - make_interval(days => $1::int)
            LIMIT ${BATCH}
         ),
         files AS (
           SELECT a.storage_key FROM message_attachments a WHERE a.message_id IN (SELECT id FROM doomed)
         ),
         gone AS (
           DELETE FROM messages WHERE id IN (SELECT id FROM doomed) RETURNING id
         )
         SELECT (SELECT count(*)::int FROM gone) AS deleted,
                COALESCE((SELECT array_agg(storage_key) FROM files), '{}') AS keys`,
        [days],
      );
      const { deleted, keys } = rows[0];
      await removeStoredFiles(keys, log);
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total > 0) log.info({ deleted: total, days }, 'deleted messages past the retention maximum');
    return total;
  } finally {
    running = false;
  }
}
