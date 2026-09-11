import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  attachmentSummary,
  messagePreview,
  type MessageNotification,
  type NotificationWorkspace,
  type Notifications,
  type Role,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { notFound, parse } from '../lib/http.js';
import { resolveReferences } from '../lib/chatReferences.js';
import { uploadUrlSql } from '../lib/storage.js';

const PREVIEW_LENGTH = 200;
const MAX_CHANNELS = 50;

const markReadSchema = z.object({
  /** Omit to mark every channel read. */
  channelIds: z.array(z.string().uuid()).max(500).optional(),
});

interface WorkspaceColumns {
  workspace_id: string;
  workspace_name: string;
  workspace_icon: string | null;
  workspace_avatar_url: string | null;
}

interface InviteRow extends WorkspaceColumns {
  id: string;
  token: string;
  role: Role;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

interface ChannelRow extends WorkspaceColumns {
  channel_id: string;
  channel_name: string;
  direct: boolean;
  unread: number;
  mentions: number;
  message_id: string;
  body: string;
  attachment_count: number;
  created_at: string;
  author_id: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
}

const WORKSPACE_SELECT = `w.id AS workspace_id, w.name AS workspace_name, w.icon AS workspace_icon,
  ${uploadUrlSql('w.avatar_key')} AS workspace_avatar_url`;

/**
 * The channels a person can read messages in: every text channel of their
 * workspaces, and the direct conversations they are part of. Expects the
 * channel as `c` and the person's id as $1.
 */
const READABLE_CHANNEL = `(c.kind = 'text' OR (c.kind = 'direct' AND EXISTS (
  SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)))`;

function workspaceOf(row: WorkspaceColumns): NotificationWorkspace {
  return {
    id: row.workspace_id,
    name: row.workspace_name,
    icon: row.workspace_icon,
    avatarUrl: row.workspace_avatar_url,
  };
}

function truncate(text: string): string {
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * What wants the signed-in person's attention on this server: invitations
 * addressed to their email, and channels and direct conversations with
 * messages they have not read.
 *
 * Unread is measured exactly as the channel list's badges measure it — newer
 * than the person's last read of the channel, from someone else, not deleted —
 * so the two never disagree.
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/notifications', async (req): Promise<Notifications> => {
    const user = req.user!;

    const [{ rows: inviteRows }, { rows: channelRows }] = await Promise.all([
      query<InviteRow>(
        `SELECT i.id, i.token, i.role, i.created_at, i.expires_at, u.name AS invited_by, ${WORKSPACE_SELECT}
           FROM workspace_invites i
           JOIN workspaces w ON w.id = i.workspace_id
           LEFT JOIN users u ON u.id = i.invited_by
          WHERE lower(i.email) = lower($1)
            AND i.accepted_at IS NULL
            AND i.expires_at > now()
            -- An invitation to a workspace already joined some other way is moot.
            AND NOT EXISTS (
              SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = $2
            )
          ORDER BY i.created_at DESC`,
        [user.email, user.id],
      ),
      query<ChannelRow>(
        `SELECT c.id AS channel_id,
                -- A direct conversation is named for the other person in it.
                CASE WHEN c.kind = 'direct' THEN COALESCE(peer.name, 'Deleted account') ELSE c.name END AS channel_name,
                (c.kind = 'direct') AS direct,
                ${WORKSPACE_SELECT},
                stats.unread, stats.mentions,
                latest.id AS message_id, latest.body, latest.attachment_count, latest.created_at,
                author.id AS author_id, author.name AS author_name,
                ${uploadUrlSql('author.avatar_key')} AS author_avatar_url
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
           JOIN channels c ON c.workspace_id = w.id AND ${READABLE_CHANNEL}
           LEFT JOIN LATERAL (
             SELECT u.name
               FROM channel_members other
               JOIN users u ON u.id = other.user_id
              WHERE other.channel_id = c.id AND other.user_id <> $1
              LIMIT 1
           ) peer ON c.kind = 'direct'
           LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = $1
           CROSS JOIN LATERAL (
             SELECT count(*)::int AS unread,
                    count(*) FILTER (
                      WHERE position('<@' || $1::text || '>' in lower(m.body)) > 0
                    )::int AS mentions
               FROM messages m
              WHERE m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id IS DISTINCT FROM $1
                AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
           ) stats
           CROSS JOIN LATERAL (
             SELECT m.id, m.body, m.created_at, m.author_id,
                    (SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
               FROM messages m
              WHERE m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id IS DISTINCT FROM $1
                AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1
           ) latest
           LEFT JOIN users author ON author.id = latest.author_id
          WHERE wm.user_id = $1 AND stats.unread > 0
          ORDER BY latest.created_at DESC
          LIMIT ${MAX_CHANNELS}`,
        [user.id],
      ),
    ]);

    const messages: MessageNotification[] = await Promise.all(
      channelRows.map(async (row) => {
        // References are resolved within the message's own workspace, as the
        // chat view does, so a pasted id cannot read a title from elsewhere.
        const references = await resolveReferences([row.body], row.workspace_id);
        return {
          channelId: row.channel_id,
          channelName: row.channel_name,
          direct: row.direct,
          workspace: workspaceOf(row),
          unread: row.unread,
          mentions: row.mentions,
          latest: {
            id: row.message_id,
            // A message that is only files has no text to preview.
            preview: truncate(messagePreview(row.body, references) || attachmentSummary(row.attachment_count)),
            createdAt: row.created_at,
            author: row.author_id
              ? { id: row.author_id, name: row.author_name ?? 'Someone', avatarUrl: row.author_avatar_url }
              : null,
          },
        };
      }),
    );

    return {
      invites: inviteRows.map((row) => ({
        id: row.id,
        token: row.token,
        role: row.role,
        invitedBy: row.invited_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        workspace: workspaceOf(row),
      })),
      messages,
    };
  });

  /** Marks channels read — the ones given, or every channel the person can read. */
  app.post('/notifications/read', async (req, reply) => {
    const input = parse(markReadSchema, req.body ?? {});
    await query(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_at)
       SELECT c.id, $1, now()
         FROM channels c
         JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $1
        WHERE ${READABLE_CHANNEL} AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
      [req.user!.id, input.channelIds ?? null],
    );
    reply.status(204);
  });

  /**
   * Turns down an invitation addressed to you. The invitation is deleted, so it
   * also leaves the inviter's list of pending invites.
   */
  app.post<{ Params: { id: string } }>('/notifications/invites/:id/decline', async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Invitation not found');
    const { rowCount } = await query(
      `DELETE FROM workspace_invites
        WHERE id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL`,
      [req.params.id, req.user!.email],
    );
    if (!rowCount) throw notFound('Invitation not found');
    reply.status(204);
  });
};
