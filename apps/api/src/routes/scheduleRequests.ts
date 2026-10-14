import type { FastifyPluginAsync } from 'fastify';
import {
  acceptRequestSchema,
  coversWindow,
  createRequestSchema,
  decideRequestSchema,
  scheduleSettingsSchema,
  type ScheduleRequest,
  type ScheduleSettings,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { assertScheduleAccess, scheduleLevelSql } from '../lib/access.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { requestChanged } from '../lib/scheduleNotifications.js';
import { expireRequests, scheduleChanged, scheduleShifts } from '../lib/schedules.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Replacement requests: someone on a schedule asking the others on it to
 * cover some of their time, or to swap it for some of theirs. Only people on
 * the same schedule can be asked, and only they can take it.
 */

/** Request columns for `q`, as seen by `$viewer`. */
function requestColumns(viewer: string): string {
  return `q.id, q.schedule_id AS "scheduleId", s.name AS "scheduleName", q.requester_id AS "requesterId",
    ru.name AS "requesterName", q.kind, q.starts_at AS "startsAt", q.ends_at AS "endsAt", q.note,
    q.ask_everyone AS "askEveryone",
    COALESCE((SELECT json_agg(json_build_object('userId', c.user_id, 'name', cu.name) ORDER BY lower(cu.name))
                FROM schedule_request_candidates c JOIN users cu ON cu.id = c.user_id
               WHERE c.request_id = q.id), '[]'::json) AS candidates,
    q.status, q.accepted_by AS "acceptedBy", au.name AS "acceptedByName", q.accepted_at AS "acceptedAt",
    q.swap_starts_at AS "swapStartsAt", q.swap_ends_at AS "swapEndsAt",
    q.decided_by AS "decidedBy", du.name AS "decidedByName", q.decided_at AS "decidedAt",
    q.decision_note AS "decisionNote", q.created_at AS "createdAt",
    (q.status = 'open' AND q.requester_id <> ${viewer}
      AND EXISTS (SELECT 1 FROM schedule_members sm WHERE sm.schedule_id = q.schedule_id AND sm.user_id = ${viewer})
      AND (q.ask_everyone OR EXISTS (SELECT 1 FROM schedule_request_candidates c
                                      WHERE c.request_id = q.id AND c.user_id = ${viewer}))) AS "canAccept"`;
}

const REQUEST_JOINS = `JOIN schedules s ON s.id = q.schedule_id
  JOIN users ru ON ru.id = q.requester_id
  LEFT JOIN users au ON au.id = q.accepted_by
  LEFT JOIN users du ON du.id = q.decided_by`;

export async function fetchRequest(id: string, viewer: string): Promise<ScheduleRequest> {
  const { rows } = await query<ScheduleRequest>(
    `SELECT ${requestColumns('$2')} FROM schedule_requests q ${REQUEST_JOINS} WHERE q.id = $1`,
    [id, viewer],
  );
  if (!rows[0]) throw notFound('Request not found');
  return rows[0];
}

/** A request on the schedule `scheduleId`, or 404. */
export async function requestOn(scheduleId: string, requestId: string) {
  const { rows } = await query<{ id: string; requester_id: string; status: string }>(
    'SELECT id, requester_id, status FROM schedule_requests WHERE id::text = $1 AND schedule_id = $2',
    [requestId, scheduleId],
  );
  if (!rows[0]) throw notFound('Request not found');
  return rows[0];
}

interface LockedRequest {
  id: string;
  schedule_id: string;
  requester_id: string;
  kind: 'cover' | 'swap';
  starts_at: string;
  ends_at: string;
  status: string;
  ask_everyone: boolean;
  accepted_by: string | null;
  swap_starts_at: string | null;
  swap_ends_at: string | null;
}

/** The request, locked for the rest of the transaction, so two people acting at once take turns. */
async function lockRequest(client: DbClient, id: string): Promise<LockedRequest> {
  const { rows } = await client.query<LockedRequest>(
    `SELECT id, schedule_id, requester_id, kind, starts_at, ends_at, status, ask_everyone, accepted_by,
            swap_starts_at, swap_ends_at
       FROM schedule_requests WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Request not found');
  return rows[0];
}

/**
 * Makes a request's overrides: whoever took it covers the requester's time,
 * and for a swap the requester covers theirs in return.
 */
async function applyRequest(client: DbClient, request: LockedRequest, acceptedBy: string, by: string): Promise<void> {
  const insert = `INSERT INTO schedule_overrides
      (schedule_id, user_id, replaced_user_id, starts_at, ends_at, source, request_id, created_by)
    VALUES ($1, $2, $3, $4, $5, 'request', $6, $7)`;
  await client.query(insert, [request.schedule_id, acceptedBy, request.requester_id, request.starts_at, request.ends_at, request.id, by]);
  if (request.kind === 'swap' && request.swap_starts_at && request.swap_ends_at) {
    await client.query(insert, [
      request.schedule_id,
      request.requester_id,
      acceptedBy,
      request.swap_starts_at,
      request.swap_ends_at,
      request.id,
      by,
    ]);
  }
}

export const scheduleRequestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string }; Querystring: { all?: string } }>('/schedules/:id/requests', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id);
    await expireRequests(access.scheduleId);
    // Open and waiting ones by default; with all=true, the last month's too.
    const { rows } = await query<ScheduleRequest>(
      `SELECT ${requestColumns('$2')} FROM schedule_requests q ${REQUEST_JOINS}
        WHERE q.schedule_id = $1
          AND (q.status IN ('open', 'accepted') OR ($3::boolean AND q.updated_at > now() - interval '30 days'))
        ORDER BY q.status IN ('open', 'accepted') DESC, q.starts_at`,
      [access.scheduleId, req.user!.id, req.query.all === 'true'],
    );
    return rows;
  });

  /** Requests the caller made or was asked on, across the schedules they can see. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/my-requests', async (req) => {
    const { roleId } = await assertWorkspaceAccess(req, req.params.id, 'schedules.view', 'schedules');
    await expireRequests();
    const { rows } = await query<ScheduleRequest>(
      `SELECT ${requestColumns('$2')} FROM schedule_requests q ${REQUEST_JOINS}
        WHERE s.workspace_id = $1 AND ${scheduleLevelSql('$2', '$3')} > 0
          AND (q.status IN ('open', 'accepted') OR q.updated_at > now() - interval '14 days')
          AND (q.requester_id = $2 OR q.accepted_by = $2
            OR (q.status = 'open'
                AND EXISTS (SELECT 1 FROM schedule_members sm WHERE sm.schedule_id = q.schedule_id AND sm.user_id = $2)
                AND (q.ask_everyone OR EXISTS (SELECT 1 FROM schedule_request_candidates c
                                                WHERE c.request_id = q.id AND c.user_id = $2))))
        ORDER BY q.status IN ('open', 'accepted') DESC, q.starts_at`,
      [req.params.id, req.user!.id, roleId],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/schedules/:id/requests', async (req, reply) => {
    const access = await assertScheduleAccess(req, req.params.id, 'request');
    const input = parse(createRequestSchema, req.body ?? {});
    const me = req.user!.id;
    if (Date.parse(input.startsAt) <= Date.now()) throw badRequest('That shift has already started');

    const { rows: schedule } = await query<{ time_zone: string }>('SELECT time_zone FROM schedules WHERE id = $1', [
      access.scheduleId,
    ]);
    const { shifts } = await scheduleShifts({ id: access.scheduleId, timeZone: schedule[0].time_zone }, input.startsAt, input.endsAt);
    if (!coversWindow(shifts, me, input.startsAt, input.endsAt)) {
      throw badRequest('You can only ask for cover on your own shifts');
    }

    const asked = [...new Set(input.askUserIds ?? [])];
    if (asked.includes(me)) throw badRequest('You cannot ask yourself');
    if (asked.length) {
      const { rows } = await query<{ count: number }>(
        'SELECT count(*)::int AS count FROM schedule_members WHERE schedule_id = $1 AND user_id = ANY($2::uuid[])',
        [access.scheduleId, asked],
      );
      if (rows[0].count !== asked.length) throw forbidden('Only people on this schedule can be asked');
    }

    const id = await transaction(async (client) => {
      // One request at a time per stretch of someone's time: the schedule is
      // locked while the overlap is checked, so two at once cannot both pass.
      await client.query('SELECT id FROM schedules WHERE id = $1 FOR UPDATE', [access.scheduleId]);
      const { rows: overlapping } = await client.query(
        `SELECT 1 FROM schedule_requests
          WHERE schedule_id = $1 AND requester_id = $2 AND status IN ('open', 'accepted')
            AND starts_at < $4 AND ends_at > $3`,
        [access.scheduleId, me, input.startsAt, input.endsAt],
      );
      if (overlapping.length) throw conflict('You already have an open request for that time');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO schedule_requests (schedule_id, requester_id, kind, starts_at, ends_at, note, ask_everyone)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [access.scheduleId, me, input.kind, input.startsAt, input.endsAt, input.note ?? '', asked.length === 0],
      );
      if (asked.length) {
        await client.query(
          'INSERT INTO schedule_request_candidates (request_id, user_id) SELECT $1, unnest($2::uuid[])',
          [rows[0].id, asked],
        );
      }
      return rows[0].id;
    });

    const request = await fetchRequest(id, me);
    await requestChanged(request, 'created', me);
    scheduleChanged(access.workspaceId, access.scheduleId);
    reply.status(201);
    return request;
  });

  /** Withdraws one's own request while it is still open or waiting for approval. */
  app.post<{ Params: { id: string; requestId: string } }>('/schedules/:id/requests/:requestId/cancel', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id);
    const request = await requestOn(access.scheduleId, req.params.requestId);
    if (request.requester_id !== req.user!.id) throw forbidden('Only the person who asked can cancel a request');
    const { rows } = await query<{ id: string }>(
      `UPDATE schedule_requests SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status IN ('open', 'accepted') RETURNING id`,
      [request.id],
    );
    if (!rows[0]) throw conflict('That request is no longer open');
    const updated = await fetchRequest(request.id, req.user!.id);
    await requestChanged(updated, 'cancelled', req.user!.id);
    scheduleChanged(access.workspaceId, access.scheduleId);
    return updated;
  });

  /**
   * Takes a request. The first to take it wins: the request is locked while it
   * is checked and changed, so two people at once produce one override. Only
   * someone on the schedule now, and asked, can take it. With approval off
   * it applies at once; with it on, it waits for a manager.
   */
  app.post<{ Params: { id: string; requestId: string } }>('/schedules/:id/requests/:requestId/accept', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'request');
    const input = parse(acceptRequestSchema, req.body ?? {});
    const me = req.user!.id;
    const found = await requestOn(access.scheduleId, req.params.requestId);
    if (found.requester_id === me) throw badRequest('You cannot take your own request');

    const { rows: schedule } = await query<{ time_zone: string; requires_approval: boolean }>(
      'SELECT time_zone, requires_approval FROM schedules WHERE id = $1',
      [access.scheduleId],
    );
    const { rows: shape } = await query<{ kind: string; starts_at: string; ends_at: string }>(
      'SELECT kind, starts_at, ends_at FROM schedule_requests WHERE id = $1',
      [found.id],
    );
    // For a swap, the shift given back must be one's own, on this schedule, still to come.
    if (shape[0].kind === 'swap') {
      const { swapStartsAt, swapEndsAt } = input;
      if (!swapStartsAt || !swapEndsAt || Date.parse(swapEndsAt) <= Date.parse(swapStartsAt)) {
        throw badRequest('Choose the shift you give in return');
      }
      if (Date.parse(swapStartsAt) <= Date.now()) throw badRequest('That shift has already started');
      if (Date.parse(swapStartsAt) < Date.parse(shape[0].ends_at) && Date.parse(swapEndsAt) > Date.parse(shape[0].starts_at)) {
        throw badRequest('The shift given in return cannot overlap the one asked about');
      }
      const { shifts } = await scheduleShifts({ id: access.scheduleId, timeZone: schedule[0].time_zone }, swapStartsAt, swapEndsAt);
      if (!coversWindow(shifts, me, swapStartsAt, swapEndsAt)) throw badRequest('You can only give one of your own shifts in return');
    }

    const applied = await transaction(async (client) => {
      const request = await lockRequest(client, found.id);
      if (request.status !== 'open') throw conflict('Someone else has already taken this, or it is no longer open');
      if (Date.parse(request.starts_at) <= Date.now()) throw conflict('That shift has already started');
      // Checked again inside the lock: whether they are on the schedule now, and were asked.
      const { rows: allowed } = await client.query<{ member: boolean; asked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM schedule_members WHERE schedule_id = $1 AND user_id = $2) AS member,
                EXISTS (SELECT 1 FROM schedule_request_candidates WHERE request_id = $3 AND user_id = $2) AS asked`,
        [request.schedule_id, me, request.id],
      );
      if (!allowed[0].member) throw forbidden('Only people on this schedule can take shifts on it');
      if (!request.ask_everyone && !allowed[0].asked) throw forbidden('You were not asked on this request');

      const swap = request.kind === 'swap' ? { start: input.swapStartsAt!, end: input.swapEndsAt! } : null;
      const approve = !schedule[0].requires_approval;
      await client.query(
        `UPDATE schedule_requests
            SET status = $2, accepted_by = $3, accepted_at = now(), swap_starts_at = $4, swap_ends_at = $5,
                decided_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [request.id, approve ? 'approved' : 'accepted', me, swap?.start ?? null, swap?.end ?? null],
      );
      if (approve) {
        await applyRequest(client, { ...request, swap_starts_at: swap?.start ?? null, swap_ends_at: swap?.end ?? null }, me, me);
      }
      return approve;
    });

    const request = await fetchRequest(found.id, me);
    await requestChanged(request, applied ? 'approved' : 'accepted', me);
    scheduleChanged(access.workspaceId, access.scheduleId);
    return request;
  });

  /** A manager, or someone allowed to approve swaps, lets a taken request apply. */
  app.post<{ Params: { id: string; requestId: string } }>('/schedules/:id/requests/:requestId/approve', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'approve');
    const { note } = parse(decideRequestSchema, req.body ?? {});
    const found = await requestOn(access.scheduleId, req.params.requestId);
    await transaction(async (client) => {
      const request = await lockRequest(client, found.id);
      if (request.status !== 'accepted' || !request.accepted_by) throw conflict('Only a request someone has taken can be approved');
      await client.query(
        `UPDATE schedule_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3,
                updated_at = now() WHERE id = $1`,
        [request.id, req.user!.id, note ?? ''],
      );
      await applyRequest(client, request, request.accepted_by, req.user!.id);
    });
    const request = await fetchRequest(found.id, req.user!.id);
    await requestChanged(request, 'approved', req.user!.id);
    scheduleChanged(access.workspaceId, access.scheduleId);
    return request;
  });

  /** Turns down a taken request: back to open for someone else, or closed. */
  app.post<{ Params: { id: string; requestId: string } }>('/schedules/:id/requests/:requestId/decline', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'approve');
    const { note, reopen } = parse(decideRequestSchema, req.body ?? {});
    const found = await requestOn(access.scheduleId, req.params.requestId);
    await transaction(async (client) => {
      const request = await lockRequest(client, found.id);
      if (request.status !== 'accepted') throw conflict('Only a request waiting for approval can be declined');
      await client.query(
        reopen
          ? `UPDATE schedule_requests SET status = 'open', accepted_by = NULL, accepted_at = NULL, swap_starts_at = NULL,
                    swap_ends_at = NULL, decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
              WHERE id = $1`
          : `UPDATE schedule_requests SET status = 'declined', decided_by = $2, decided_at = now(), decision_note = $3,
                    updated_at = now() WHERE id = $1`,
        [request.id, req.user!.id, note ?? ''],
      );
    });
    const request = await fetchRequest(found.id, req.user!.id);
    await requestChanged(request, 'declined', req.user!.id);
    scheduleChanged(access.workspaceId, access.scheduleId);
    return request;
  });

  /** The caller's own choices about schedules: how long before a shift to remind them. */
  app.get('/schedule-settings', async (req): Promise<ScheduleSettings> => {
    const { rows } = await query<{ reminder_minutes: number }>('SELECT reminder_minutes FROM schedule_user_settings WHERE user_id = $1', [
      req.user!.id,
    ]);
    return { reminderMinutes: rows[0]?.reminder_minutes ?? 60 };
  });

  app.put('/schedule-settings', async (req): Promise<ScheduleSettings> => {
    const input = parse(scheduleSettingsSchema, req.body ?? {});
    await query(
      `INSERT INTO schedule_user_settings (user_id, reminder_minutes) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET reminder_minutes = EXCLUDED.reminder_minutes`,
      [req.user!.id, input.reminderMinutes],
    );
    return input;
  });
};
