import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ScheduleNotificationReason, ScheduleOverride, ScheduleRequest } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { appEnabledSql } from './apps.js';
import { deliver, useEmailLog } from './scheduleDelivery.js';
import { expireRequests, loadLayers, scheduleShifts } from './schedules.js';

/**
 * Telling people when their shifts change, and before they start. Overrides
 * and requests call in here; what is sent, and how, is decided here and in
 * scheduleDelivery.ts.
 */

interface Notice {
  userId: string;
  scheduleId: string;
  reason: ScheduleNotificationReason;
  actorId: string | null;
  requestId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  detail?: string;
  /** For what must go out once only, however often it is tried. */
  dedupeKey?: string;
}

/** Records notices and sends them. Nobody is told about what they did themselves. */
export async function notify(notices: Notice[]): Promise<void> {
  const seen = new Set<string>();
  const wanted = notices.filter((n) => {
    const key = `${n.userId}:${n.reason}:${n.dedupeKey ?? ''}`;
    if (n.userId === n.actorId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (wanted.length === 0) return;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO schedule_notifications
       (user_id, schedule_id, reason, actor_id, request_id, starts_at, ends_at, detail, dedupe_key)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::timestamptz[],
                          $7::timestamptz[], $8::text[], $9::text[])
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      wanted.map((n) => n.userId),
      wanted.map((n) => n.scheduleId),
      wanted.map((n) => n.reason),
      wanted.map((n) => n.actorId),
      wanted.map((n) => n.requestId ?? null),
      wanted.map((n) => n.startsAt ?? null),
      wanted.map((n) => n.endsAt ?? null),
      wanted.map((n) => n.detail ?? ''),
      wanted.map((n) => n.dedupeKey ?? null),
    ],
  );
  await deliver(rows.map((r) => r.id));
}

/** An override was made or taken away: the covered and covering people hear of it. */
export async function overrideChanged(override: ScheduleOverride, change: 'created' | 'removed', actorId: string): Promise<void> {
  // One made by a request is told about as the request.
  if (override.source === 'request') return;
  const base = { scheduleId: override.scheduleId, actorId, startsAt: override.startsAt, endsAt: override.endsAt };
  const reason = change === 'created' ? 'override' : 'override_removed';
  await notify([
    { ...base, reason, userId: override.userId, detail: override.replacedUserName ? `covering for ${override.replacedUserName}` : '' },
    ...(override.replacedUserId
      ? [{ ...base, reason, userId: override.replacedUserId, detail: `${override.userName} covers for you` } as const]
      : []),
  ]);
}

/** Everyone a request asked: those named, or everyone else on the schedule. */
async function askedOn(request: ScheduleRequest): Promise<string[]> {
  if (!request.askEveryone) return request.candidates.map((c) => c.userId);
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM schedule_members WHERE schedule_id = $1 AND user_id <> $2',
    [request.scheduleId, request.requesterId],
  );
  return rows.map((r) => r.user_id);
}

/** A schedule's managers, who hear about what needs approving or is going uncovered. */
async function managersOf(scheduleId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>('SELECT user_id FROM schedule_members WHERE schedule_id = $1 AND manager', [
    scheduleId,
  ]);
  return rows.map((r) => r.user_id);
}

/** Something happened to a replacement request: the people it concerns hear of it. */
export async function requestChanged(
  request: ScheduleRequest,
  change: 'created' | 'cancelled' | 'accepted' | 'approved' | 'declined',
  actorId: string,
): Promise<void> {
  const base = {
    scheduleId: request.scheduleId,
    requestId: request.id,
    actorId,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
  };
  const to = (userIds: (string | null)[], reason: ScheduleNotificationReason, detail = '') =>
    userIds.filter((id): id is string => Boolean(id)).map((userId) => ({ ...base, userId, reason, detail }));

  if (change === 'created') return notify(to(await askedOn(request), 'request'));
  if (change === 'cancelled') return notify(to([request.acceptedBy], 'cancelled'));
  if (change === 'accepted') {
    return notify([...to([request.requesterId], 'accepted'), ...to(await managersOf(request.scheduleId), 'approval', request.requesterName)]);
  }
  if (change === 'approved') {
    return notify([...to([request.requesterId], 'approved'), ...to([request.acceptedBy], 'approved', request.requesterName)]);
  }
  return notify(to([request.requesterId, request.acceptedBy], 'declined'));
}

// --- the sweep ------------------------------------------------------------------

const SWEEP_INTERVAL = 60_000;
/** How far ahead reminders are looked for: the longest lead anyone can choose. */
const LOOKAHEAD = 24 * 3_600_000;
/** A shift that started this recently still gets its "you are on call". */
const ON_CALL_GRACE = 10 * 60_000;
/** Open requests this close to starting warn the requester and managers. */
const EXPIRY_WARNING = 2 * 3_600_000;

/**
 * Reminders before shifts, "you are on call" as on-call shifts start, and
 * warnings about requests about to go unanswered. Each is keyed so it goes
 * out once, however many servers sweep at once. Schedules in workspaces with
 * the app turned off are skipped.
 */
export async function sweepScheduleNotices(now = new Date()): Promise<void> {
  const from = new Date(now.getTime() - ON_CALL_GRACE).toISOString();
  const to = new Date(now.getTime() + LOOKAHEAD).toISOString();
  const { rows: schedules } = await query<{ id: string; time_zone: string }>(
    `SELECT s.id, s.time_zone FROM schedules s WHERE ${appEnabledSql('s.workspace_id', 'schedules')}`,
  );
  const { rows: settings } = await query<{ user_id: string; reminder_minutes: number }>(
    'SELECT user_id, reminder_minutes FROM schedule_user_settings',
  );
  const lead = new Map(settings.map((s) => [s.user_id, s.reminder_minutes]));

  const notices: Notice[] = [];
  for (const schedule of schedules) {
    const layers = await loadLayers(schedule.id);
    if (layers.length === 0) continue;
    const kinds = new Map(layers.map((l) => [l.lineageId, l.kind]));
    const { shifts } = await scheduleShifts({ id: schedule.id, timeZone: schedule.time_zone }, from, to, layers);
    for (const shift of shifts) {
      const start = Date.parse(shift.start);
      const base = { userId: shift.userId, scheduleId: schedule.id, actorId: null, startsAt: shift.start, endsAt: shift.end };
      const minutes = lead.get(shift.userId) ?? 60;
      if (minutes > 0 && start > now.getTime() && start - minutes * 60_000 <= now.getTime()) {
        notices.push({ ...base, reason: 'reminder', dedupeKey: `reminder:${schedule.id}:${shift.start}` });
      }
      const onCall = shift.lineageId && kinds.get(shift.lineageId) === 'rotation';
      if (onCall && start <= now.getTime() && start > now.getTime() - ON_CALL_GRACE) {
        notices.push({ ...base, reason: 'on_call', dedupeKey: `oncall:${schedule.id}:${shift.start}` });
      }
    }
  }

  // Requests about to go unanswered, claimed so each is warned about once.
  const { rows: expiring } = await query<{ id: string; schedule_id: string; requester_id: string; starts_at: string; ends_at: string }>(
    `UPDATE schedule_requests SET warned_at = now()
      WHERE status = 'open' AND warned_at IS NULL AND starts_at > $1 AND starts_at <= $2
      RETURNING id, schedule_id, requester_id, starts_at, ends_at`,
    [now.toISOString(), new Date(now.getTime() + EXPIRY_WARNING).toISOString()],
  );
  for (const request of expiring) {
    for (const userId of [request.requester_id, ...(await managersOf(request.schedule_id))]) {
      notices.push({
        userId,
        scheduleId: request.schedule_id,
        requestId: request.id,
        reason: 'expiring',
        actorId: null,
        startsAt: request.starts_at,
        endsAt: request.ends_at,
      });
    }
  }

  await notify(notices);
  await expireRequests();
}

/** Sweeps every minute once the server is up, until it closes. */
export function scheduleShiftNotices(app: FastifyInstance): void {
  useEmailLog(app.log);
  const sweep = (log: FastifyBaseLogger) =>
    sweepScheduleNotices().catch((err) => log.warn({ err }, 'schedule notice sweep failed'));
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => void sweep(app.log), SWEEP_INTERVAL);
    timer.unref();
  });
  app.addHook('onClose', async () => clearInterval(timer));
}
