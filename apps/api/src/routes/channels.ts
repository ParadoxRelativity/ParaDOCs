import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  MAX_REACTIONS_PER_MESSAGE,
  createChannelSchema,
  createMessageSchema,
  reactionSchema,
  updateChannelSchema,
  updateMessageSchema,
  type Channel,
  type Message,
  type MessageAttachment,
  type MessageReferences,
} from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess, roleAtLeast, type Role } from '../plugins/session.js';
import { resolveReferences } from '../lib/chatReferences.js';
import { removeStoredFile, removeStoredFiles, storeUpload, uploadLimits, uploadUrlSql } from '../lib/storage.js';
import { publishToChannel } from '../chat/hub.js';

const CHANNEL_COLUMNS = `c.id, c.workspace_id AS "workspaceId", c.name, c.topic, c.kind,
  c.position, c.created_at AS "createdAt"`;

const ATTACHMENT_COLUMNS = `a.id, a.filename, a.mime_type AS "mimeType", a.byte_size::float8 AS "byteSize",
  '/uploads/' || a.storage_key AS url, a.width, a.height`;

const MESSAGE_COLUMNS = `m.id, m.channel_id AS "channelId", m.body,
  m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt",
  CASE WHEN u.id IS NULL THEN NULL
       ELSE json_build_object('id', u.id, 'name', u.name, 'email', u.email,
                              'avatarUrl', ${uploadUrlSql('u.avatar_key')}) END AS author,
  COALESCE((
    SELECT json_agg(json_build_object(
             'id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'byteSize', a.byte_size,
             'url', '/uploads/' || a.storage_key, 'width', a.width, 'height', a.height)
           ORDER BY a.position, a.created_at)
      FROM message_attachments a
     WHERE a.message_id = m.id
  ), '[]'::json) AS attachments,
  COALESCE((
    SELECT json_agg(json_build_object('emoji', r.emoji, 'users', r.users) ORDER BY r.first_at)
      FROM (
        SELECT mr.emoji, min(mr.created_at) AS first_at,
               json_agg(json_build_object('id', ru.id, 'name', ru.name) ORDER BY mr.created_at) AS users
          FROM message_reactions mr
          JOIN users ru ON ru.id = mr.user_id
         WHERE mr.message_id = m.id
         GROUP BY mr.emoji
      ) r
  ), '[]'::json) AS reactions`;

const NO_REFERENCES: MessageReferences = { documents: [], channels: [], members: [] };

type Queryable = { query: typeof query };

async function selectMessage(db: Queryable, id: string): Promise<Message> {
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1`,
    [id],
  );
  return rows[0];
}

/** Resolves a channel and checks the caller's role in its workspace. */
async function channelAccess(
  req: FastifyRequest,
  channelId: string,
  minimum: Role = 'viewer',
): Promise<{ workspaceId: string; role: Role; kind: 'text' | 'voice' }> {
  const { rows } = await query<{ workspace_id: string; kind: 'text' | 'voice' }>(
    'SELECT workspace_id, kind FROM channels WHERE id = $1',
    [channelId],
  );
  if (!rows[0]) throw notFound('Channel not found');
  const role = await assertWorkspaceAccess(req, rows[0].workspace_id, minimum);
  return { workspaceId: rows[0].workspace_id, role, kind: rows[0].kind };
}

export const channelRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // --- channels ------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/workspaces/:id/channels', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const { rows } = await query<Channel>(
      `SELECT ${CHANNEL_COLUMNS},
              (SELECT count(*)::int FROM messages m
                WHERE m.channel_id = c.id
                  AND m.deleted_at IS NULL
                  AND m.author_id IS DISTINCT FROM $2
                  AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)) AS unread,
              -- Mentions are matched on the stored token rather than the name,
              -- so someone renaming themselves cannot change what counts.
              (SELECT count(*)::int FROM messages m
                WHERE m.channel_id = c.id
                  AND m.deleted_at IS NULL
                  AND m.author_id IS DISTINCT FROM $2
                  AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
                  AND position('<@' || $2::text || '>' in lower(m.body)) > 0) AS mentions
         FROM channels c
         LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = $2
        WHERE c.workspace_id = $1
        ORDER BY c.kind, c.position, lower(c.name)`,
      [req.params.id, req.user!.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/channels', async (req, reply) => {
    // Adding and removing channels is an owner/admin job, as asked.
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const input = parse(createChannelSchema, req.body);

    const { rows: clash } = await query('SELECT 1 FROM channels WHERE workspace_id = $1 AND lower(name) = $2', [
      req.params.id,
      input.name,
    ]);
    if (clash.length) throw conflict(`There is already a #${input.name} channel`);

    const { rows } = await query<Channel>(
      `WITH inserted AS (
         INSERT INTO channels (workspace_id, name, topic, kind, created_by, position)
         VALUES ($1, $2, $3, $4, $5,
                 COALESCE((SELECT max(position) + 1 FROM channels WHERE workspace_id = $1), 0))
         RETURNING *
       )
       SELECT ${CHANNEL_COLUMNS} FROM inserted c`,
      [req.params.id, input.name, input.topic ?? null, input.kind, req.user!.id],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/channels/:id', async (req) => {
    const { workspaceId } = await channelAccess(req, req.params.id, 'admin');
    const input = parse(updateChannelSchema, req.body);

    if (input.name) {
      const { rows: clash } = await query(
        'SELECT 1 FROM channels WHERE workspace_id = $1 AND lower(name) = $2 AND id <> $3',
        [workspaceId, input.name, req.params.id],
      );
      if (clash.length) throw conflict(`There is already a #${input.name} channel`);
    }

    const { rows } = await query<Channel>(
      `WITH updated AS (
         UPDATE channels
            SET name = COALESCE($2, name),
                -- A null topic is a real value here: it clears the topic.
                topic = CASE WHEN $4::boolean THEN $3 ELSE topic END,
                position = COALESCE($5, position)
          WHERE id = $1 RETURNING *
       )
       SELECT ${CHANNEL_COLUMNS} FROM updated c`,
      [
        req.params.id,
        input.name ?? null,
        input.topic ?? null,
        Object.prototype.hasOwnProperty.call(input, 'topic'),
        input.position ?? null,
      ],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const { workspaceId } = await channelAccess(req, req.params.id, 'admin');
    const { rows } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM channels WHERE workspace_id = $1',
      [workspaceId],
    );
    // A workspace with no channels has a chat tab that cannot do anything.
    if (rows[0].count <= 1) throw badRequest('A workspace must keep at least one channel');

    // The rows for its files cascade away with the channel, so the files
    // themselves are collected first and removed once it is gone.
    const { rows: files } = await query<{ storage_key: string }>(
      'SELECT storage_key FROM message_attachments WHERE channel_id = $1',
      [req.params.id],
    );
    await query('DELETE FROM channels WHERE id = $1', [req.params.id]);
    await removeStoredFiles(
      files.map((f) => f.storage_key),
      req.log,
    );
    reply.status(204);
  });

  // --- messages ------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/channels/:id/messages',
    async (req) => {
      const { workspaceId, kind } = await channelAccess(req, req.params.id);
      if (kind !== 'text') throw badRequest('That channel does not carry messages');

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      // Paged newest-first from a cursor, then flipped, so the client can
      // prepend a page of history without reordering what it already has.
      const { rows } = await query<Message>(
        `SELECT ${MESSAGE_COLUMNS}
           FROM messages m LEFT JOIN users u ON u.id = m.author_id
          WHERE m.channel_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3`,
        [req.params.id, req.query.before ?? null, limit],
      );
      const messages = rows.reverse();
      return {
        messages,
        hasMore: rows.length === limit,
        references: await resolveReferences(
          messages.map((m) => m.body),
          workspaceId,
        ),
      };
    },
  );

  app.post<{ Params: { id: string } }>('/channels/:id/messages', async (req, reply) => {
    // Viewers are read-only for documents but may comment; chat follows that.
    const { workspaceId, kind } = await channelAccess(req, req.params.id);
    if (kind !== 'text') throw badRequest('That channel does not carry messages');
    const input = parse(createMessageSchema, req.body);
    const attachmentIds = input.attachmentIds ?? [];

    const message = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id',
        [req.params.id, req.user!.id, input.body],
      );
      const id = rows[0].id;

      if (attachmentIds.length > 0) {
        // Only the sender's own unsent files in this channel can be claimed, so
        // an id cannot pull someone else's file into a message.
        const { rows: claimed } = await client.query(
          `UPDATE message_attachments a
              SET message_id = $1, position = ids.position
             FROM unnest($2::uuid[]) WITH ORDINALITY AS ids(id, position)
            WHERE a.id = ids.id
              AND a.channel_id = $3
              AND a.uploader_id = $4
              AND a.message_id IS NULL
          RETURNING a.id`,
          [id, attachmentIds, req.params.id, req.user!.id],
        );
        if (claimed.length !== attachmentIds.length) {
          throw badRequest('A file in this message is no longer available. Remove it and add it again.');
        }
      }

      return selectMessage(client, id);
    });
    const references = await resolveReferences([message.body], workspaceId);

    // Posting is also reading: the author's own message must not come back as
    // unread the moment they send it.
    await markRead(req.params.id, req.user!.id);
    publishToChannel(req.params.id, { type: 'message.created', message, references });

    reply.status(201);
    return { message, references };
  });

  app.patch<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const found = await messageRow(req.params.id);
    const { workspaceId } = await channelAccess(req, found.channel_id);
    if (found.author_id !== req.user!.id) throw forbidden('You can only edit your own messages');
    if (found.deleted_at) throw badRequest('That message was deleted');

    const input = parse(updateMessageSchema, req.body);
    if (!input.body) {
      // Emptying the text is fine for a message that still has its files.
      const { rows } = await query('SELECT 1 FROM message_attachments WHERE message_id = $1 LIMIT 1', [
        req.params.id,
      ]);
      if (rows.length === 0) throw badRequest('Write something first');
    }

    await query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [req.params.id, input.body]);
    const message = await selectMessage({ query }, req.params.id);
    const references = await resolveReferences([message.body], workspaceId);
    publishToChannel(found.channel_id, { type: 'message.updated', message, references });
    return { message, references };
  });

  app.delete<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const found = await messageRow(req.params.id);
    const { role } = await channelAccess(req, found.channel_id);
    // Your own message, or anyone's if you moderate the workspace.
    if (found.author_id !== req.user!.id && !roleAtLeast(role, 'admin')) {
      throw forbidden('You can only delete your own messages');
    }

    // Soft delete: the row stays so clients can reconcile without refetching.
    // Its files and reactions go, though — deleting a message is how someone
    // takes back a file they shared.
    const files = await transaction(async (client) => {
      const { rows } = await client.query<{ storage_key: string }>(
        'DELETE FROM message_attachments WHERE message_id = $1 RETURNING storage_key',
        [req.params.id],
      );
      await client.query('DELETE FROM message_reactions WHERE message_id = $1', [req.params.id]);
      await client.query(`UPDATE messages SET deleted_at = now(), body = '' WHERE id = $1`, [req.params.id]);
      return rows.map((r) => r.storage_key);
    });
    await removeStoredFiles(files, req.log);

    publishToChannel(found.channel_id, {
      type: 'message.deleted',
      message: await selectMessage({ query }, req.params.id),
      references: NO_REFERENCES,
    });
    reply.status(204);
  });

  // --- files ---------------------------------------------------------------

  /**
   * Uploads one file for a message that has not been sent yet. The message box
   * uploads a file as soon as it is added, so sending is instant; the message
   * it is sent with then claims it.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/attachments', async (req, reply) => {
    const { kind } = await channelAccess(req, req.params.id);
    if (kind !== 'text') throw badRequest('That channel does not carry messages');

    const file = await req.file(uploadLimits());
    if (!file) throw badRequest('No file was uploaded');

    // Sent ahead of the file by the client, which measures images and videos
    // so the message list can hold their space before they load. Only a
    // matching pair is kept: one side alone cannot give a shape.
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const width = dimension(fields?.width?.value);
    const height = dimension(fields?.height?.value);
    const measured = width !== null && height !== null;

    const { storageKey, byteSize } = await storeUpload(file, `chat/${req.params.id}`);
    const { rows } = await query<MessageAttachment>(
      `INSERT INTO message_attachments AS a
         (channel_id, uploader_id, filename, mime_type, byte_size, storage_key, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        req.params.id,
        req.user!.id,
        displayName(file.filename),
        (file.mimetype || 'application/octet-stream').slice(0, 100),
        byteSize,
        storageKey,
        measured ? width : null,
        measured ? height : null,
      ],
    );

    await sweepUnsentFiles(req);
    reply.status(201);
    return rows[0];
  });

  /** Removes a file from a message that has not been sent yet. */
  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const { rows } = await query<{ storage_key: string }>(
      `DELETE FROM message_attachments
        WHERE id = $1 AND uploader_id = $2 AND message_id IS NULL
        RETURNING storage_key`,
      [req.params.id, req.user!.id],
    );
    if (!rows[0]) throw notFound('File not found');
    await removeStoredFile(rows[0].storage_key);
    reply.status(204);
  });

  // --- reactions -----------------------------------------------------------

  app.put<{ Params: { id: string; emoji: string } }>('/messages/:id/reactions/:emoji', async (req) => {
    const { emoji } = parse(reactionSchema, { emoji: req.params.emoji });
    const found = await messageRow(req.params.id);
    await channelAccess(req, found.channel_id);
    if (found.deleted_at) throw badRequest('That message was deleted');

    const { rows } = await query<{ kinds: number; present: boolean }>(
      `SELECT count(DISTINCT emoji)::int AS kinds, COALESCE(bool_or(emoji = $2), false) AS present
         FROM message_reactions WHERE message_id = $1`,
      [req.params.id, emoji],
    );
    // Joining an existing reaction is always allowed; only new emoji are capped.
    if (!rows[0].present && rows[0].kinds >= MAX_REACTIONS_PER_MESSAGE) {
      throw badRequest(`A message can have up to ${MAX_REACTIONS_PER_MESSAGE} different reactions`);
    }

    await query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.user!.id, emoji],
    );
    return publishReactions(found.channel_id, req.params.id);
  });

  app.delete<{ Params: { id: string; emoji: string } }>('/messages/:id/reactions/:emoji', async (req) => {
    const { emoji } = parse(reactionSchema, { emoji: req.params.emoji });
    const found = await messageRow(req.params.id);
    await channelAccess(req, found.channel_id);

    await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
      req.params.id,
      req.user!.id,
      emoji,
    ]);
    return publishReactions(found.channel_id, req.params.id);
  });

  // --- read state ----------------------------------------------------------

  app.post<{ Params: { id: string } }>('/channels/:id/read', async (req, reply) => {
    await channelAccess(req, req.params.id);
    await markRead(req.params.id, req.user!.id);
    reply.status(204);
  });
};

/**
 * A reaction changes a message without editing it, so it travels as an update.
 * The text is unchanged, so every client showing the message already has its
 * references.
 */
async function publishReactions(channelId: string, messageId: string): Promise<{ message: Message }> {
  const message = await selectMessage({ query }, messageId);
  publishToChannel(channelId, { type: 'message.updated', message, references: NO_REFERENCES });
  return { message };
}

/**
 * Files uploaded for a message that was never sent: the tab was closed, or the
 * draft abandoned. A day leaves plenty of time for a message still being
 * written.
 */
async function sweepUnsentFiles(req: FastifyRequest): Promise<void> {
  try {
    const { rows } = await query<{ storage_key: string }>(
      `DELETE FROM message_attachments
        WHERE message_id IS NULL AND created_at < now() - interval '1 day'
        RETURNING storage_key`,
    );
    await removeStoredFiles(
      rows.map((r) => r.storage_key),
      req.log,
    );
  } catch (err) {
    req.log.warn({ err }, 'could not remove unsent chat files');
  }
}

function dimension(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 30000 ? n : null;
}

/** The name a file is shown and downloaded under. It is never used as a path. */
function displayName(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  return clean.slice(0, 200) || 'file';
}

async function messageRow(id: string) {
  const { rows } = await query<{ channel_id: string; author_id: string | null; deleted_at: string | null }>(
    'SELECT channel_id, author_id, deleted_at FROM messages WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw notFound('Message not found');
  return rows[0];
}

async function markRead(channelId: string, userId: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES ($1, $2, now())
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
      [channelId, userId],
    );
  });
}
