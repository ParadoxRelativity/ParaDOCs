import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  createChannelSchema,
  createMessageSchema,
  updateChannelSchema,
  updateMessageSchema,
  type Channel,
  type Message,
} from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess, roleAtLeast, type Role } from '../plugins/session.js';
import { resolveReferences } from '../lib/chatReferences.js';
import { uploadUrlSql } from '../lib/storage.js';
import { publishToChannel } from '../chat/hub.js';

const CHANNEL_COLUMNS = `c.id, c.workspace_id AS "workspaceId", c.name, c.topic, c.kind,
  c.position, c.created_at AS "createdAt"`;

const MESSAGE_COLUMNS = `m.id, m.channel_id AS "channelId", m.body,
  m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt",
  CASE WHEN u.id IS NULL THEN NULL
       ELSE json_build_object('id', u.id, 'name', u.name, 'email', u.email,
                              'avatarUrl', ${uploadUrlSql('u.avatar_key')}) END AS author`;

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

    await query('DELETE FROM channels WHERE id = $1', [req.params.id]);
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

    const { rows } = await query<Message>(
      `WITH inserted AS (
         INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING *
       )
       SELECT ${MESSAGE_COLUMNS} FROM inserted m LEFT JOIN users u ON u.id = m.author_id`,
      [req.params.id, req.user!.id, input.body],
    );
    const message = rows[0];
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
    const { rows } = await query<Message>(
      `WITH updated AS (
         UPDATE messages SET body = $2, edited_at = now() WHERE id = $1 RETURNING *
       )
       SELECT ${MESSAGE_COLUMNS} FROM updated m LEFT JOIN users u ON u.id = m.author_id`,
      [req.params.id, input.body],
    );
    const message = rows[0];
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
    const { rows } = await query<Message>(
      `WITH updated AS (
         UPDATE messages SET deleted_at = now(), body = '' WHERE id = $1 RETURNING *
       )
       SELECT ${MESSAGE_COLUMNS} FROM updated m LEFT JOIN users u ON u.id = m.author_id`,
      [req.params.id],
    );
    publishToChannel(found.channel_id, {
      type: 'message.deleted',
      message: rows[0],
      references: { documents: [], channels: [], members: [] },
    });
    reply.status(204);
  });

  // --- read state ----------------------------------------------------------

  app.post<{ Params: { id: string } }>('/channels/:id/read', async (req, reply) => {
    await channelAccess(req, req.params.id);
    await markRead(req.params.id, req.user!.id);
    reply.status(204);
  });
};

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
