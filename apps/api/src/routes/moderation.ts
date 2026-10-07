import type { FastifyPluginAsync } from 'fastify';
import { reportMessageSchema, type BlockedUser } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { UUID, channelAccessFor } from '../lib/channels.js';
import { managesAccess } from '../lib/roles.js';
import { uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { publishToUser } from '../chat/hub.js';

/**
 * The least moderation the app stores ask of an app where people post things:
 * reporting a message, and blocking a person (Apple's guideline 1.2, Google
 * Play's user-generated content policy). The rest is the server operator's and
 * the workspace admins', who already have the tools to remove a message or a
 * member.
 *
 * A report goes to the owners and admins of the message's workspace, through
 * their notifications, until one of them resolves it. There is no review queue
 * beyond that yet.
 *
 * A block is the blocker's alone and holds across the server. See
 * lib/blocks.ts for what it hides and what it stops.
 */

/** The owners and admins of a workspace hear that its reports have changed. */
async function notifyWorkspaceAdmins(workspaceId: string): Promise<void> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role IN ('owner', 'admin')`,
    [workspaceId],
  );
  for (const { user_id } of rows) publishToUser(user_id, { type: 'notifications.changed' });
}

/** Your other windows and devices hide, or stop hiding, what you just changed. */
function blocksChanged(userId: string): void {
  publishToUser(userId, { type: 'blocks.changed' });
  // Unread counts leave out what you blocked, so they change too.
  publishToUser(userId, { type: 'notifications.changed' });
}

export const moderationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // --- reports -------------------------------------------------------------

  /** Reports a message to the owners and admins of its workspace. */
  app.post<{ Params: { id: string } }>('/messages/:id/report', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('Message not found');
    const input = parse(reportMessageSchema, req.body ?? {});
    const self = req.user!;

    const { rows } = await query<{
      channel_id: string;
      author_id: string | null;
      author_name: string | null;
      body: string;
      deleted_at: string | null;
      attachment_count: number;
    }>(
      `SELECT m.channel_id, m.author_id, u.name AS author_name, m.body, m.deleted_at,
              (SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.id = $1`,
      [req.params.id],
    );
    const message = rows[0];
    if (!message) throw notFound('Message not found');
    // Seeing the message is what entitles someone to report it.
    const access = await channelAccessFor(self.id, message.channel_id);
    if (!access) throw notFound('Message not found');
    if (access.kind !== 'text' && access.kind !== 'direct') throw badRequest('That channel does not carry messages');
    if (message.deleted_at) throw badRequest('That message was deleted');
    if (message.author_id === self.id) throw badRequest('You cannot report your own message');

    const direct = access.kind === 'direct';
    // Reporting again, before it is resolved, keeps the first report and its
    // date, and takes the latest reason.
    await query(
      `INSERT INTO message_reports
         (workspace_id, channel_id, message_id, direct, channel_name, author_id, author_name,
          body, attachment_count, reporter_id, reporter_name, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (message_id, reporter_id) WHERE resolved_at IS NULL
       DO UPDATE SET reason = EXCLUDED.reason`,
      [
        access.workspaceId,
        message.channel_id,
        req.params.id,
        direct,
        direct ? '' : access.name,
        message.author_id,
        message.author_name ?? 'Deleted account',
        message.body,
        message.attachment_count,
        self.id,
        self.name,
        input.reason || null,
      ],
    );
    req.log.info(
      { messageId: req.params.id, by: self.id, workspaceId: access.workspaceId },
      'message reported to workspace admins',
    );
    await notifyWorkspaceAdmins(access.workspaceId);
    reply.status(204);
  });

  /**
   * Marks a report dealt with, along with everyone else's open reports of the
   * same message. Whatever was done about it, such as deleting the message or
   * removing its author, is done the usual way.
   */
  app.post<{ Params: { id: string } }>('/reports/:id/resolve', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('Report not found');
    const { rows } = await query<{ workspace_id: string; message_id: string | null }>(
      'SELECT workspace_id, message_id FROM message_reports WHERE id = $1',
      [req.params.id],
    );
    const report = rows[0];
    if (!report) throw notFound('Report not found');
    const actor = await assertWorkspaceAccess(req, report.workspace_id);
    if (!managesAccess(actor.role)) throw forbidden('Only owners and admins can resolve reports');

    await query(
      `UPDATE message_reports SET resolved_at = now(), resolved_by = $2
        WHERE resolved_at IS NULL
          AND (id = $1 OR (message_id = $3 AND workspace_id = $4))`,
      [req.params.id, req.user!.id, report.message_id, report.workspace_id],
    );
    req.log.info({ reportId: req.params.id, by: req.user!.id }, 'message report resolved');
    await notifyWorkspaceAdmins(report.workspace_id);
    reply.status(204);
  });

  // --- blocks --------------------------------------------------------------

  app.get('/blocks', async (req): Promise<BlockedUser[]> => {
    const { rows } = await query<BlockedUser>(
      `SELECT u.id, u.name, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl", b.created_at AS "blockedAt"
         FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY lower(u.name), u.id`,
      [req.user!.id],
    );
    return rows;
  });

  app.put<{ Params: { userId: string } }>('/blocks/:userId', async (req, reply) => {
    const target = req.params.userId.toLowerCase();
    if (!UUID.test(target)) throw notFound('That person was not found');
    if (target === req.user!.id) throw badRequest('You cannot block yourself');
    const { rowCount: exists } = await query('SELECT 1 FROM users WHERE id = $1', [target]);
    if (!exists) throw notFound('That person was not found');

    const { rowCount } = await query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user!.id, target],
    );
    if (rowCount) {
      req.log.info({ by: req.user!.id, blocked: target }, 'user blocked');
      blocksChanged(req.user!.id);
    }
    reply.status(204);
  });

  app.delete<{ Params: { userId: string } }>('/blocks/:userId', async (req, reply) => {
    const target = req.params.userId.toLowerCase();
    if (!UUID.test(target)) throw notFound('That person was not found');
    const { rowCount } = await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [
      req.user!.id,
      target,
    ]);
    if (rowCount) {
      req.log.info({ by: req.user!.id, unblocked: target }, 'user unblocked');
      blocksChanged(req.user!.id);
    }
    reply.status(204);
  });
};
