import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  attachmentSummary,
  messagePreview,
  type DocumentMode,
  type MentionNotification,
  type MessageNotification,
  type NotificationWorkspace,
  type Notifications,
  type Role,
  type WorkItemNotification,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { notFound, parse } from '../lib/http.js';
import { resolveReferences } from '../lib/chatReferences.js';
import { channelLevelSql, documentLevelSql, projectLevelSql } from '../lib/access.js';
import { appEnabledSql } from '../lib/apps.js';
import { mentionsUserSql } from '../lib/channels.js';
import { uploadUrlSql } from '../lib/storage.js';
import { availableServerUpdate } from '../lib/releases.js';

const PREVIEW_LENGTH = 200;
const MAX_CHANNELS = 50;

const markReadSchema = z.object({
  /** Omit to mark every channel read. */
  channelIds: z.array(z.string().uuid()).max(500).optional(),
});

const readMentionsSchema = z.object({
  /** Omit to clear every tag addressed to you. */
  documentIds: z.array(z.string().uuid()).max(500).optional(),
});

const MAX_MENTIONS = 50;

const readWorkItemsSchema = z.object({
  /** Omit to clear every work item notification. */
  itemIds: z.array(z.string().uuid()).max(500).optional(),
});

interface WorkItemRow extends WorkspaceColumns {
  work_item_id: string;
  project_id: string;
  key: string;
  title: string;
  reason: 'role' | 'mention';
  detail: string | null;
  created_at: string;
  author_id: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
}

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

interface MentionRow extends WorkspaceColumns {
  document_id: string;
  title: string;
  mode: DocumentMode;
  created_at: string;
  author_id: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
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
 * The channels a person can read messages in: the text channels of their
 * workspaces not locked away from them, and the direct conversations they are
 * part of. Expects the channel as `c` and the person's id as $1; `role` is SQL
 * for their role in the channel's workspace.
 */
function readableChannel(role: string): string {
  return `((c.kind = 'text' AND ${channelLevelSql('$1', role)} > 0) OR (c.kind = 'direct' AND EXISTS (
  SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)))`;
}

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

async function isServerAdmin(userId: string): Promise<boolean> {
  const { rows } = await query<{ admin: boolean }>('SELECT is_server_admin AS admin FROM users WHERE id = $1', [userId]);
  return rows[0]?.admin === true;
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

    const [{ rows: inviteRows }, { rows: channelRows }, { rows: mentionRows }, { rows: workItemRows }] = await Promise.all([
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
                -- A direct conversation is named for the other people in it,
                -- unless it is a group someone gave a name.
                CASE WHEN c.kind = 'direct'
                     THEN COALESCE(NULLIF(c.name, ''), peer.names,
                                   CASE WHEN c.direct_group THEN 'Just you' ELSE 'Deleted account' END)
                     ELSE c.name END AS channel_name,
                (c.kind = 'direct') AS direct,
                ${WORKSPACE_SELECT},
                stats.unread, stats.mentions,
                latest.id AS message_id, latest.body, latest.attachment_count, latest.created_at,
                author.id AS author_id, author.name AS author_name,
                ${uploadUrlSql('author.avatar_key')} AS author_avatar_url
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
           JOIN channels c ON c.workspace_id = w.id AND ${readableChannel('wm.role')}
                          AND ${appEnabledSql('w.id', 'chat')}
           LEFT JOIN LATERAL (
             SELECT string_agg(u.name, ', ' ORDER BY lower(u.name), u.id) AS names
               FROM channel_members other
               JOIN users u ON u.id = other.user_id
              WHERE other.channel_id = c.id AND other.user_id <> $1
           ) peer ON c.kind = 'direct'
           LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = $1
           CROSS JOIN LATERAL (
             SELECT count(*)::int AS unread,
                    count(*) FILTER (
                      WHERE ${mentionsUserSql('$1')}
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
      // Documents and canvases someone has tagged this person in. Membership and
      // locks are rechecked here rather than trusted from when the tag was
      // written: losing access to a document has to take its tags with it.
      query<MentionRow>(
        `SELECT dm.document_id, dm.created_at, d.title, d.mode,
                ${WORKSPACE_SELECT},
                author.id AS author_id, author.name AS author_name,
                ${uploadUrlSql('author.avatar_key')} AS author_avatar_url
           FROM document_mentions dm
           JOIN documents d ON d.id = dm.document_id
           JOIN workspaces w ON w.id = d.workspace_id
           JOIN workspace_members wm ON wm.workspace_id = d.workspace_id AND wm.user_id = $1
           LEFT JOIN users author ON author.id = dm.created_by
          WHERE dm.user_id = $1
            AND dm.read_at IS NULL
            -- An archived document is off the shelf; a tag in one is not news.
            AND d.archived_at IS NULL
            AND ${appEnabledSql('d.workspace_id', 'docs')}
            AND ${documentLevelSql('$1', 'wm.role')} > 0
          ORDER BY dm.created_at DESC
          LIMIT ${MAX_MENTIONS}`,
        [user.id],
      ),
      // Work items given to this person or naming them. As with tags, whether
      // they can still open the project is asked now, not when it was written.
      query<WorkItemRow>(
        `SELECT n.work_item_id, i.project_id, p.key || '-' || i.number AS key, i.title,
                n.reason, n.detail, n.created_at,
                ${WORKSPACE_SELECT},
                author.id AS author_id, author.name AS author_name,
                ${uploadUrlSql('author.avatar_key')} AS author_avatar_url
           FROM work_item_notifications n
           JOIN work_items i ON i.id = n.work_item_id
           JOIN projects p ON p.id = i.project_id
           JOIN workspaces w ON w.id = p.workspace_id
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $1
           LEFT JOIN users author ON author.id = n.created_by
          WHERE n.user_id = $1
            AND n.read_at IS NULL
            AND p.archived_at IS NULL
            AND ${appEnabledSql('p.workspace_id', 'projects')}
            AND ${projectLevelSql('$1', 'wm.role')} > 0
          ORDER BY n.created_at DESC
          LIMIT ${MAX_MENTIONS}`,
        [user.id],
      ),
    ]);

    // Only administrators hear about releases, and only while there is one, so
    // the usual request costs no extra query.
    const release = availableServerUpdate();
    const serverUpdate = release && (await isServerAdmin(user.id)) ? release : null;

    const messages: MessageNotification[] = await Promise.all(
      channelRows.map(async (row) => {
        // References are resolved within the message's own workspace, as the
        // chat view does, so a pasted id cannot read a title from elsewhere.
        const references = await resolveReferences([row.body], row.workspace_id, user.id);
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
      mentions: mentionRows.map(
        (row): MentionNotification => ({
          documentId: row.document_id,
          title: row.title,
          mode: row.mode,
          workspace: workspaceOf(row),
          taggedBy: row.author_id
            ? { id: row.author_id, name: row.author_name ?? 'Someone', avatarUrl: row.author_avatar_url }
            : null,
          createdAt: row.created_at,
        }),
      ),
      workItems: workItemRows.map(
        (row): WorkItemNotification => ({
          workItemId: row.work_item_id,
          projectId: row.project_id,
          key: row.key,
          title: row.title,
          reason: row.reason,
          role: row.detail,
          workspace: workspaceOf(row),
          by: row.author_id
            ? { id: row.author_id, name: row.author_name ?? 'Someone', avatarUrl: row.author_avatar_url }
            : null,
          createdAt: row.created_at,
        }),
      ),
      serverUpdate,
    };
  });

  /** Clears work item notifications — the ones given, or all of them. Opening the item is what normally calls this. */
  app.post('/notifications/work-items/read', async (req, reply) => {
    const input = parse(readWorkItemsSchema, req.body ?? {});
    await query(
      `UPDATE work_item_notifications
          SET read_at = now()
        WHERE user_id = $1
          AND read_at IS NULL
          AND ($2::uuid[] IS NULL OR work_item_id = ANY($2::uuid[]))`,
      [req.user!.id, input.itemIds ?? null],
    );
    reply.status(204);
  });

  /** Marks channels read — the ones given, or every channel the person can read. */
  app.post('/notifications/read', async (req, reply) => {
    const input = parse(markReadSchema, req.body ?? {});
    await query(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_at)
       SELECT c.id, $1, now()
         FROM channels c
         JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $1
        WHERE ${readableChannel('m.role')} AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
      [req.user!.id, input.channelIds ?? null],
    );
    reply.status(204);
  });

  /**
   * Clears tags addressed to you — the ones given, or all of them. Opening the
   * document is what normally calls this, so a tag stops asking for attention
   * once it has been paid.
   */
  app.post('/notifications/mentions/read', async (req, reply) => {
    const input = parse(readMentionsSchema, req.body ?? {});
    await query(
      `UPDATE document_mentions
          SET read_at = now()
        WHERE user_id = $1
          AND read_at IS NULL
          AND ($2::uuid[] IS NULL OR document_id = ANY($2::uuid[]))`,
      [req.user!.id, input.documentIds ?? null],
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
