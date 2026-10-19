import { scheduleNotificationText, type ScheduleNotificationReason } from '@paradocs/shared';
import { publishToUser } from '../chat/hub.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/**
 * How schedule notifications reach people. Each channel takes what is due
 * and the time it was sent is recorded against it, per channel, so a channel
 * added later picks up from where it is turned on and nothing goes twice.
 *
 * In the app is the one channel that delivers. Email is built — subject, text
 * and link — and handed to a transport that, for now, only logs it.
 */

export interface DueNotice {
  id: string;
  userId: string;
  email: string;
  reason: ScheduleNotificationReason;
  scheduleId: string;
  scheduleName: string;
  workspaceId: string;
  startsAt: string | null;
  endsAt: string | null;
  detail: string;
  byName: string | null;
}

export interface DeliveryChannel {
  name: 'in_app' | 'email';
  /** Where its sent time is kept. */
  column: 'in_app_sent_at' | 'email_sent_at';
  deliver: (notices: DueNotice[]) => Promise<void>;
}

/** The bell: tells each person's open windows to ask again. */
export const inAppChannel: DeliveryChannel = {
  name: 'in_app',
  column: 'in_app_sent_at',
  async deliver(notices) {
    for (const userId of new Set(notices.map((n) => n.userId))) publishToUser(userId, { type: 'notifications.changed' });
  },
};

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  link: string;
}

export type EmailTransport = (message: EmailMessage) => Promise<void>;

let logLine: (message: EmailMessage) => void = () => {};

/** Where the email channel's messages go. Nowhere yet: they are logged, once a logger is given. */
let transport: EmailTransport = async (message) => logLine(message);

/** Gives the stub transport a logger to write to. */
export function useEmailLog(log: { info: (obj: object, msg: string) => void }): void {
  logLine = (message) => log.info({ to: message.to, subject: message.subject }, 'schedule email not sent: email is not set up');
}

/** Swaps the email transport, for tests and for when email is set up. */
export function setEmailTransport(next: EmailTransport): void {
  transport = next;
}

function when(notice: DueNotice): string {
  if (!notice.startsAt) return '';
  const range = new Date(notice.startsAt).toUTCString();
  return notice.endsAt ? `${range} until ${new Date(notice.endsAt).toUTCString()}` : range;
}

/** The email a notice would be, whether or not it is sent. */
export function emailFor(notice: DueNotice): EmailMessage {
  const subject = scheduleNotificationText({
    reason: notice.reason,
    detail: notice.detail,
    scheduleName: notice.scheduleName,
    by: notice.byName ? { id: '', name: notice.byName, avatarUrl: null } : null,
  });
  const link = `${config.publicUrl.replace(/\/$/, '')}/w/${notice.workspaceId}/sc/${notice.scheduleId}`;
  const text = [`${subject}.`, when(notice), '', `Open the schedule: ${link}`].join('\n');
  return { to: notice.email, subject, text, link };
}

export const emailChannel: DeliveryChannel = {
  name: 'email',
  column: 'email_sent_at',
  async deliver(notices) {
    for (const notice of notices) await transport(emailFor(notice));
  },
};

export const CHANNELS: DeliveryChannel[] = [inAppChannel, emailChannel];

/** Sends the notifications given through every channel that has not sent them yet. */
export async function deliver(ids: string[], channels: DeliveryChannel[] = CHANNELS): Promise<void> {
  if (ids.length === 0) return;
  for (const channel of channels) {
    // Claimed and marked in one statement, so two servers never both send one.
    const { rows } = await query<DueNotice>(
      `WITH due AS (
         UPDATE schedule_notifications SET ${channel.column} = now()
          WHERE id = ANY($1::uuid[]) AND ${channel.column} IS NULL
          RETURNING *
       )
       SELECT n.id, n.user_id AS "userId", u.email, n.reason, n.schedule_id AS "scheduleId", s.name AS "scheduleName",
              s.workspace_id AS "workspaceId", n.starts_at AS "startsAt", n.ends_at AS "endsAt", n.detail,
              actor.name AS "byName"
         FROM due n
         JOIN users u ON u.id = n.user_id
         JOIN schedules s ON s.id = n.schedule_id
         LEFT JOIN users actor ON actor.id = n.actor_id`,
      [ids],
    );
    if (rows.length) await channel.deliver(rows);
  }
}
