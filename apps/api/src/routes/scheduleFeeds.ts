import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { MyShift } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { assertScheduleAccess, roleIdSql, scheduleLevelSql } from '../lib/access.js';
import { publicOrigin } from '../lib/aiTokens.js';
import { appEnabledSql } from '../lib/apps.js';
import { notFound, parse } from '../lib/http.js';
import { shiftsOf } from '../lib/schedules.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Calendar feeds: an iCal address with someone's own shifts, or a whole
 * schedule's, for a phone or desktop calendar to subscribe to. The address is
 * the only key, so the secret in it is kept as a hash, shown once when made,
 * and replaced by resetting it. Each time it is read, whether its owner may
 * still see what it shows is asked again.
 */

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** How far back and ahead a feed reaches. */
const PAST_DAYS = 30;
const AHEAD_DAYS = 180;

const feedQuery = z.object({ scheduleId: z.string().uuid().optional() });

export interface FeedStatus {
  /** Whether there is a feed, and the end of its secret to recognise it by. */
  hint: string | null;
  createdAt: string | null;
  /** Only when it was just made: it cannot be shown again. */
  url?: string;
}

/** Text as iCal wants it: commas, semicolons and backslashes escaped, lines as \\n. */
function icalText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** An instant as iCal's UTC form, 20260105T090000Z. */
function icalTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lines folded at 75 octets, as iCal requires, continuing with a space. */
function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

export function toIcal(
  feed: { name: string; workspaceId: string; everyone: boolean },
  shifts: MyShift[],
  names: Map<string, string>,
  origin: string,
): string {
  const { name, workspaceId, everyone } = feed;
  const stamp = icalTime(new Date().toISOString());
  const events = shifts.map((shift) => {
    const who = names.get(shift.userId) ?? 'Someone';
    const covering = shift.overriddenFrom ? ` (covering for ${names.get(shift.overriddenFrom) ?? 'someone'})` : '';
    const summary = everyone ? `${who}${covering}` : `${shift.scheduleName}${shift.label ? ` · ${shift.label}` : ''}${covering}`;
    return [
      'BEGIN:VEVENT',
      `UID:${shift.scheduleId}-${shift.userId}-${icalTime(shift.start)}@paradocs`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icalTime(shift.start)}`,
      `DTEND:${icalTime(shift.end)}`,
      `SUMMARY:${icalText(summary)}`,
      `URL:${origin}/w/${workspaceId}/sc/${shift.scheduleId}`,
      'END:VEVENT',
    ];
  });
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ParaDOCs//Schedules//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icalText(name)}`,
    ...events.flat(),
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n');
}

export const scheduleFeedRoutes: FastifyPluginAsync = async (app) => {
  /** Whether the caller has a feed, for their own shifts or for one schedule. */
  app.get<{ Params: { id: string }; Querystring: { scheduleId?: string } }>(
    '/workspaces/:id/calendar-feed',
    { preHandler: app.requireAuth },
    async (req): Promise<FeedStatus> => {
      await assertWorkspaceAccess(req, req.params.id, 'schedules.view', 'schedules');
      const { scheduleId } = parse(feedQuery, req.query);
      if (scheduleId) await assertScheduleAccess(req, scheduleId);
      const { rows } = await query<{ hint: string; created_at: string }>(
        `SELECT hint, created_at FROM schedule_feed_tokens
          WHERE user_id = $1 AND workspace_id = $2 AND schedule_id IS NOT DISTINCT FROM $3`,
        [req.user!.id, req.params.id, scheduleId ?? null],
      );
      return { hint: rows[0]?.hint ?? null, createdAt: rows[0]?.created_at ?? null };
    },
  );

  /** Makes a feed, or resets one: the old address stops working. Its address is shown this once. */
  app.post<{ Params: { id: string }; Querystring: { scheduleId?: string } }>(
    '/workspaces/:id/calendar-feed',
    { preHandler: app.requireAuth },
    async (req): Promise<FeedStatus> => {
      await assertWorkspaceAccess(req, req.params.id, 'schedules.view', 'schedules');
      const { scheduleId } = parse(feedQuery, req.query);
      if (scheduleId) {
        const access = await assertScheduleAccess(req, scheduleId);
        if (access.workspaceId !== req.params.id) throw notFound('Schedule not found');
      }
      const token = crypto.randomBytes(24).toString('base64url');
      await query(
        `DELETE FROM schedule_feed_tokens WHERE user_id = $1 AND workspace_id = $2 AND schedule_id IS NOT DISTINCT FROM $3`,
        [req.user!.id, req.params.id, scheduleId ?? null],
      );
      const { rows } = await query<{ created_at: string }>(
        `INSERT INTO schedule_feed_tokens (user_id, workspace_id, schedule_id, token_hash, hint)
         VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
        [req.user!.id, req.params.id, scheduleId ?? null, hashToken(token), token.slice(-4)],
      );
      return { hint: token.slice(-4), createdAt: rows[0].created_at, url: `${publicOrigin(req)}/api/calendar-feeds/${token}.ics` };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { scheduleId?: string } }>(
    '/workspaces/:id/calendar-feed',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      await assertWorkspaceAccess(req, req.params.id);
      const { scheduleId } = parse(feedQuery, req.query);
      await query(
        `DELETE FROM schedule_feed_tokens WHERE user_id = $1 AND workspace_id = $2 AND schedule_id IS NOT DISTINCT FROM $3`,
        [req.user!.id, req.params.id, scheduleId ?? null],
      );
      reply.status(204);
    },
  );

  /**
   * The feed itself, read by a calendar app with no session: the token is the
   * key. Anything that would refuse its owner in the app — leaving the
   * workspace, losing sight of the schedule, Schedules turned off — makes it
   * not found here too.
   */
  app.get<{ Params: { token: string } }>('/calendar-feeds/:token', async (req, reply) => {
    const token = req.params.token.replace(/\.ics$/, '');
    const { rows } = await query<{ id: string; user_id: string; workspace_id: string; schedule_id: string | null; role_id: string | null; name: string | null }>(
      `SELECT t.id, t.user_id, t.workspace_id, t.schedule_id, ${roleIdSql('t.user_id', 't.workspace_id')} AS role_id,
              s.name
         FROM schedule_feed_tokens t
         LEFT JOIN schedules s ON s.id = t.schedule_id
        WHERE t.token_hash = $1 AND ${appEnabledSql('t.workspace_id', 'schedules')}`,
      [hashToken(token)],
    );
    const feed = rows[0];
    if (!feed?.role_id) throw notFound('Feed not found');
    const { rows: allowed } = await query<{ ok: boolean }>(
      `SELECT role_grants($2, 'schedules.view')
              AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM schedules s WHERE s.id = $3 AND ${scheduleLevelSql('$1', '$2')} > 0)) AS ok`,
      [feed.user_id, feed.role_id, feed.schedule_id],
    );
    if (!allowed[0]?.ok) throw notFound('Feed not found');

    const now = Date.now();
    const from = new Date(now - PAST_DAYS * 86_400_000).toISOString();
    const to = new Date(now + AHEAD_DAYS * 86_400_000).toISOString();
    const shifts = await shiftsOf(feed.workspace_id, feed.user_id, feed.role_id, from, to, feed.schedule_id ?? undefined);
    const people = [...new Set(shifts.flatMap((s) => [s.userId, s.overriddenFrom].filter((id): id is string => Boolean(id))))];
    const { rows: named } = await query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [people]);
    await query('UPDATE schedule_feed_tokens SET last_used_at = now() WHERE id = $1', [feed.id]);

    const body = toIcal(
      { name: feed.name ?? 'My shifts', workspaceId: feed.workspace_id, everyone: Boolean(feed.schedule_id) },
      shifts,
      new Map(named.map((n) => [n.id, n.name])),
      publicOrigin(req),
    );
    reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'no-store');
    return body;
  });
};
