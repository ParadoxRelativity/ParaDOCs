import type { FastifyPluginAsync } from 'fastify';
import { openDirectSchema, type Channel } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess, workspaceRole } from '../plugins/session.js';

/**
 * Direct conversations: a channel of kind 'direct' between two members of a
 * workspace. Everything said in one goes through the ordinary message routes,
 * which admit only the two people in it.
 *
 * A conversation shows in someone's list once it has messages, or once they
 * have opened it themselves — not merely because the other person opened it
 * and then said nothing.
 */
async function listDirect(workspaceId: string, userId: string, channelId: string | null): Promise<Channel[]> {
  const { rows } = await query<Channel>(
    `SELECT c.id, c.workspace_id AS "workspaceId", c.name, c.topic, c.kind, c.position,
            c.created_at AS "createdAt",
            CASE WHEN peer.id IS NULL THEN NULL
                 ELSE json_build_object('id', peer.id, 'name', peer.name, 'email', peer.email,
                                        'avatarUrl', ${uploadUrlSql('peer.avatar_key')}) END AS peer,
            latest.last_at AS "lastMessageAt",
            (SELECT count(*)::int FROM messages m
              WHERE m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id IS DISTINCT FROM $2
                AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)) AS unread,
            (SELECT count(*)::int FROM messages m
              WHERE m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id IS DISTINCT FROM $2
                AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
                AND position('<@' || $2::text || '>' in lower(m.body)) > 0) AS mentions
       FROM channel_members mine
       JOIN channels c ON c.id = mine.channel_id
       LEFT JOIN LATERAL (
         SELECT u.id, u.name, u.email, u.avatar_key
           FROM channel_members other
           JOIN users u ON u.id = other.user_id
          WHERE other.channel_id = c.id AND other.user_id <> $2
          LIMIT 1
       ) peer ON true
       LEFT JOIN LATERAL (
         SELECT max(m.created_at) AS last_at
           FROM messages m
          WHERE m.channel_id = c.id AND m.deleted_at IS NULL
       ) latest ON true
       LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = $2
      WHERE mine.user_id = $2
        AND c.workspace_id = $1
        AND c.kind = 'direct'
        AND ($3::uuid IS NULL OR c.id = $3::uuid)
        AND (latest.last_at IS NOT NULL OR r.channel_id IS NOT NULL)
      ORDER BY COALESCE(latest.last_at, c.created_at) DESC`,
    [workspaceId, userId, channelId],
  );
  return rows;
}

export const directRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /** The signed-in person's direct conversations in a workspace, most recent first. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/direct', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    return listDirect(req.params.id, req.user!.id, null);
  });

  /** Opens the conversation with another member, starting it if there is none yet. */
  app.post<{ Params: { id: string } }>('/workspaces/:id/direct', async (req) => {
    const workspaceId = req.params.id;
    await assertWorkspaceAccess(req, workspaceId);
    const { userId } = parse(openDirectSchema, req.body);
    const self = req.user!.id;
    if (userId === self) throw badRequest('Pick someone other than yourself');
    if (!(await workspaceRole(userId, workspaceId))) {
      throw notFound('That person is not a member of this workspace');
    }

    // Sorted, so it is the same key whichever of the two opens it.
    const key = [self, userId].sort().join(':');
    const channelId = await transaction(async (client) => {
      // Two people opening the conversation at once both land on one channel:
      // the second insert waits on the first and then does nothing.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, name, kind, created_by, dm_key)
         VALUES ($1, '', 'direct', $2, $3)
         ON CONFLICT (workspace_id, dm_key) WHERE dm_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [workspaceId, self, key],
      );
      const id =
        inserted[0]?.id ??
        (
          await client.query<{ id: string }>('SELECT id FROM channels WHERE workspace_id = $1 AND dm_key = $2', [
            workspaceId,
            key,
          ])
        ).rows[0].id;

      await client.query(
        `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [id, self, userId],
      );
      // Records that this person opened it, which is what puts an empty
      // conversation in their list. A read at the epoch marks nothing as read,
      // and an existing read position is left alone.
      await client.query(
        `INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES ($1, $2, 'epoch')
         ON CONFLICT DO NOTHING`,
        [id, self],
      );
      return id;
    });

    const [channel] = await listDirect(workspaceId, self, channelId);
    return channel;
  });
};
