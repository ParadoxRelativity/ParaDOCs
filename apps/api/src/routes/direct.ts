import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  MAX_DIRECT_PEOPLE,
  addDirectMembersSchema,
  openDirectSchema,
  renameDirectSchema,
  type Channel,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { UUID, channelAccessFor, mentionsUserSql } from '../lib/channels.js';
import { removeStoredFiles, uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { publishToUser } from '../chat/hub.js';
import { removeFromCall } from './voice.js';

/**
 * Direct conversations: a channel of kind 'direct' between two or more members
 * of a workspace. Everything said in one goes through the ordinary message
 * routes, which admit only the people in it.
 *
 * The same people land in the same conversation, the way a pair always has.
 * A conversation started with more than one other person is a group: anyone in
 * it can rename it, add people, remove people, or leave. A pair's conversation
 * never changes hands — adding someone to it starts a group instead, so a
 * private history is never opened up to a third person.
 *
 * A conversation shows in someone's list once it has messages, or once they
 * have opened it themselves — not merely because the other person opened it
 * and then said nothing.
 */
async function listDirect(workspaceId: string, userId: string, channelId: string | null): Promise<Channel[]> {
  const { rows } = await query<Channel>(
    `SELECT c.id, c.workspace_id AS "workspaceId", c.name, c.topic, c.kind, c.position,
            c.created_at AS "createdAt", c.direct_group AS "group",
            others.people -> 0 AS peer,
            COALESCE(others.people, '[]'::json) AS members,
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
                AND ${mentionsUserSql('$2')}) AS mentions
       FROM channel_members mine
       JOIN channels c ON c.id = mine.channel_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email,
                                           'avatarUrl', ${uploadUrlSql('u.avatar_key')})
                         ORDER BY lower(u.name), u.id) AS people
           FROM channel_members other
           JOIN users u ON u.id = other.user_id
          WHERE other.channel_id = c.id AND other.user_id <> $2
       ) others ON true
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

/** A pair's key is their two ids; a group's is marked, so the two can never collide. */
function directKey(people: string[]): string {
  const ids = [...people].sort().join(':');
  return people.length > 2 ? `group:${ids}` : ids;
}

/** Every id given is a member of the workspace. */
async function assertMembers(workspaceId: string, userIds: string[]): Promise<void> {
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])',
    [workspaceId, userIds],
  );
  if (rows.length !== userIds.length) {
    throw notFound(
      userIds.length === 1
        ? 'That person is not a member of this workspace'
        : 'Someone you picked is not a member of this workspace',
    );
  }
}

/**
 * Records that someone opened a conversation, which is what puts an empty one
 * in their list. A read at the epoch marks nothing as read, and an existing
 * read position is left alone.
 */
async function markOpened(client: DbClient, channelId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES ($1, $2, 'epoch')
     ON CONFLICT DO NOTHING`,
    [channelId, userId],
  );
}

/**
 * A group conversation the caller is in, locked for the rest of the
 * transaction so two changes to its people are made one after the other.
 * Returns who is in it now.
 */
async function lockGroup(client: DbClient, channelId: string): Promise<string[]> {
  const { rows } = await client.query<{ direct_group: boolean }>(
    'SELECT direct_group FROM channels WHERE id = $1 FOR UPDATE',
    [channelId],
  );
  if (!rows[0]?.direct_group) throw badRequest('Only a group conversation can be changed');
  const { rows: members } = await client.query<{ user_id: string }>(
    'SELECT user_id FROM channel_members WHERE channel_id = $1',
    [channelId],
  );
  return members.map((m) => m.user_id);
}

/**
 * Brings a group's key into line with who is in it now, so opening a
 * conversation with exactly these people finds it. When another group already
 * has these people, that one keeps the key and this one is simply not found
 * that way.
 */
async function rekeyGroup(client: DbClient, channelId: string, people: string[]): Promise<void> {
  await client.query(
    `UPDATE channels c
        SET dm_key = CASE WHEN EXISTS (
                       SELECT 1 FROM channels o
                        WHERE o.workspace_id = c.workspace_id AND o.dm_key = $2 AND o.id <> c.id
                     ) THEN NULL ELSE $2 END
      WHERE c.id = $1`,
    [channelId, `group:${[...people].sort().join(':')}`],
  );
}

/** The caller's access to a direct conversation, which must exist and include them. */
async function directAccess(req: FastifyRequest, channelId: string): Promise<{ workspaceId: string }> {
  const access = await channelAccessFor(req.user!.id, channelId);
  if (!access || access.kind !== 'direct') throw notFound('Conversation not found');
  return { workspaceId: access.workspaceId };
}

/** Everyone who was or is in the conversation refreshes their list. */
function directsChanged(workspaceId: string, people: Iterable<string>): void {
  for (const userId of new Set(people)) publishToUser(userId, { type: 'directs.changed', workspaceId });
}

export const directRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /** The signed-in person's direct conversations in a workspace, most recent first. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/direct', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'viewer', 'chat');
    return listDirect(req.params.id, req.user!.id, null);
  });

  /** Opens the conversation with one or more other members, starting it if there is none yet. */
  app.post<{ Params: { id: string } }>('/workspaces/:id/direct', async (req) => {
    const workspaceId = req.params.id;
    await assertWorkspaceAccess(req, workspaceId, 'viewer', 'chat');
    const input = parse(openDirectSchema, req.body);
    const self = req.user!.id;
    const others = [...new Set((input.userIds ?? [input.userId!]).map((id) => id.toLowerCase()))].filter(
      (id) => id !== self,
    );
    if (others.length === 0) throw badRequest('Pick someone other than yourself');
    await assertMembers(workspaceId, others);

    // Sorted, so it is the same key whoever among them opens it.
    const people = [self, ...others];
    const key = directKey(people);
    const group = people.length > 2;
    const channelId = await transaction(async (client) => {
      // Two people opening the conversation at once both land on one channel:
      // the second insert waits on the first and then does nothing.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, name, kind, created_by, dm_key, direct_group)
         VALUES ($1, '', 'direct', $2, $3, $4)
         ON CONFLICT (workspace_id, dm_key) WHERE dm_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [workspaceId, self, key, group],
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
        `INSERT INTO channel_members (channel_id, user_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [id, people],
      );
      await markOpened(client, id, self);
      return id;
    });

    const [channel] = await listDirect(workspaceId, self, channelId);
    return channel;
  });

  /** Names a group conversation, or with an empty name, goes back to naming it for its people. */
  app.patch<{ Params: { id: string } }>('/direct/:id', async (req) => {
    const { workspaceId } = await directAccess(req, req.params.id);
    const { name } = parse(renameDirectSchema, req.body);
    const self = req.user!.id;

    const people = await transaction(async (client) => {
      const current = await lockGroup(client, req.params.id);
      await client.query('UPDATE channels SET name = $2 WHERE id = $1', [req.params.id, name]);
      await markOpened(client, req.params.id, self);
      return current;
    });

    req.log.info({ channelId: req.params.id, by: self }, 'group conversation renamed');
    directsChanged(workspaceId, people);
    const [channel] = await listDirect(workspaceId, self, req.params.id);
    return channel;
  });

  /**
   * Adds people to a group conversation. They can read everything already said
   * in it, and start with it all marked read rather than as a wall of unread.
   */
  app.post<{ Params: { id: string } }>('/direct/:id/members', async (req) => {
    const { workspaceId } = await directAccess(req, req.params.id);
    const self = req.user!.id;
    const requested = [...new Set(parse(addDirectMembersSchema, req.body).userIds.map((id) => id.toLowerCase()))];
    await assertMembers(workspaceId, requested);

    const { before, after } = await transaction(async (client) => {
      const current = await lockGroup(client, req.params.id);
      const adding = requested.filter((id) => !current.includes(id));
      if (current.length + adding.length > MAX_DIRECT_PEOPLE) {
        throw badRequest(`A conversation can have up to ${MAX_DIRECT_PEOPLE} people`);
      }
      if (adding.length > 0) {
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id) SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [req.params.id, adding],
        );
        // Someone added back after leaving starts from now too.
        await client.query(
          `INSERT INTO channel_reads (channel_id, user_id, last_read_at)
           SELECT $1, unnest($2::uuid[]), now()
           ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
          [req.params.id, adding],
        );
        await rekeyGroup(client, req.params.id, [...current, ...adding]);
      }
      await markOpened(client, req.params.id, self);
      return { before: current, after: [...current, ...adding] };
    });

    if (after.length > before.length) {
      req.log.info({ channelId: req.params.id, by: self, added: after.length - before.length }, 'people added to group conversation');
    }
    directsChanged(workspaceId, after);
    const [channel] = await listDirect(workspaceId, self, req.params.id);
    return channel;
  });

  /**
   * Takes someone out of a group conversation: yourself, which is leaving, or
   * someone else, as long as two people remain. They stop receiving it at once
   * and are taken out of its call. A group nobody is left in is deleted, with
   * its files.
   */
  app.delete<{ Params: { id: string; userId: string } }>('/direct/:id/members/:userId', async (req, reply) => {
    const { workspaceId } = await directAccess(req, req.params.id);
    const self = req.user!.id;
    const target = req.params.userId.toLowerCase();
    if (!UUID.test(target)) throw notFound('That person is not in this conversation');
    const leaving = target === self;

    const { before, files } = await transaction(async (client) => {
      const current = await lockGroup(client, req.params.id);
      if (!current.includes(target)) throw notFound('That person is not in this conversation');
      if (!leaving && current.length <= 2) {
        throw badRequest('A group needs at least two people. Leave it instead.');
      }
      await client.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [
        req.params.id,
        target,
      ]);
      const remaining = current.filter((id) => id !== target);
      if (remaining.length > 0) {
        await rekeyGroup(client, req.params.id, remaining);
        return { before: current, files: [] as string[] };
      }
      // The last person out. The rows for its files cascade away with the
      // channel, so the files themselves are collected first.
      const { rows } = await client.query<{ storage_key: string }>(
        'SELECT storage_key FROM message_attachments WHERE channel_id = $1',
        [req.params.id],
      );
      await client.query('DELETE FROM channels WHERE id = $1', [req.params.id]);
      return { before: current, files: rows.map((r) => r.storage_key) };
    });

    req.log.info({ channelId: req.params.id, by: self, removed: target }, leaving ? 'left group conversation' : 'removed from group conversation');
    await removeStoredFiles(files, req.log);
    await removeFromCall(req.params.id, target, req.log);
    directsChanged(workspaceId, before);
    reply.status(204);
  });
};
