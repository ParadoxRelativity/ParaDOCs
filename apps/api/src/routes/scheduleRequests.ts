import type { FastifyPluginAsync } from 'fastify';
import { coversWindow, createRequestSchema, type ScheduleRequest } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
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
};
