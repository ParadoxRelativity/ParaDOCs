import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createLayerSchema,
  orderLayersSchema,
  parseLayerConfig,
  updateLayerSchema,
  createScheduleSchema,
  setOverrideGrantsSchema,
  setScheduleMembersSchema,
  updateScheduleSchema,
  type LayerConfig,
  type MyShift,
  type LayerMember,
  type OverrideGrant,
  type PatternConfig,
  type RecurringConfig,
  type ScheduleLayerKind,
  type Schedule,
  type ScheduleLayer,
  type ScheduleMember,
  type ScheduleSummary,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { assertScheduleAccess, scheduleLevelSql, type ScheduleAccess } from '../lib/access.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { leaveSchedules, loadLayers, reviseLineage, scheduleChanged, scheduleShifts, writeLayerMembers } from '../lib/schedules.js';
import { uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Schedules: the schedules themselves, who is on them, and who may override
 * them. Layers, shifts, overrides and requests have routes of their own.
 */

/** Summary columns for the schedule `s`, as seen by `user`. */
function summaryColumns(user: string): string {
  return `s.id, s.workspace_id AS "workspaceId", s.name, s.description, s.time_zone AS "timeZone", s.color,
    s.requires_approval AS "requiresApproval", s.access,
    (SELECT count(*)::int FROM schedule_members sm WHERE sm.schedule_id = s.id) AS "memberCount",
    EXISTS (SELECT 1 FROM schedule_members sm WHERE sm.schedule_id = s.id AND sm.user_id = ${user}) AS "isMember",
    COALESCE((SELECT sm.manager FROM schedule_members sm WHERE sm.schedule_id = s.id AND sm.user_id = ${user}), false)
      AS "isManager"`;
}

async function loadMembers(scheduleId: string): Promise<ScheduleMember[]> {
  const { rows } = await query<ScheduleMember>(
    `SELECT sm.user_id AS "userId", u.name, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl", sm.manager
       FROM schedule_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.schedule_id = $1
      ORDER BY sm.manager DESC, lower(u.name)`,
    [scheduleId],
  );
  return rows;
}

async function loadGrants(scheduleId: string): Promise<OverrideGrant[]> {
  const { rows } = await query<OverrideGrant>(
    `SELECT CASE WHEN g.team_id IS NULL THEN 'user' ELSE 'team' END AS kind,
            COALESCE(g.team_id, g.user_id) AS id, COALESCE(t.name, u.name) AS name
       FROM schedule_override_grants g
       LEFT JOIN teams t ON t.id = g.team_id
       LEFT JOIN users u ON u.id = g.user_id
      WHERE g.schedule_id = $1
      ORDER BY g.team_id IS NULL, lower(COALESCE(t.name, u.name))`,
    [scheduleId],
  );
  return rows;
}

export async function fetchSchedule(access: ScheduleAccess, userId: string): Promise<Schedule> {
  const { rows } = await query<ScheduleSummary & { createdBy: string | null }>(
    `SELECT ${summaryColumns('$2')}, s.created_by AS "createdBy" FROM schedules s WHERE s.id = $1`,
    [access.scheduleId, userId],
  );
  const [members, layers, overrideGrants] = await Promise.all([
    loadMembers(access.scheduleId),
    loadLayers(access.scheduleId),
    loadGrants(access.scheduleId),
  ]);
  return { ...rows[0], members, layers, overrideGrants, can: access.can };
}

/** Refuses anyone listed who is not a member of the workspace. */
async function assertWorkspaceMembers(workspaceId: string, userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const { rows } = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])',
    [workspaceId, unique],
  );
  if (rows[0].count !== unique.length) throw badRequest('Everyone on a schedule must be a member of this workspace');
}

async function writeMembers(client: DbClient, scheduleId: string, members: { userId: string; manager?: boolean }[]) {
  await client.query(
    `INSERT INTO schedule_members (schedule_id, user_id, manager)
     SELECT $1, x.user_id, x.manager FROM unnest($2::uuid[], $3::boolean[]) AS x(user_id, manager)
     ON CONFLICT (schedule_id, user_id) DO UPDATE SET manager = EXCLUDED.manager`,
    [scheduleId, members.map((m) => m.userId), members.map((m) => m.manager ?? false)],
  );
}

/** One line per person, the last word on each winning. */
function dedupe<T extends { userId: string }>(list: T[]): T[] {
  return [...new Map(list.map((m) => [m.userId, m])).values()];
}


function checkedConfig(kind: ScheduleLayerKind, config: unknown): LayerConfig {
  const result = parseLayerConfig(kind, config);
  if (!result.ok) throw badRequest(result.error);
  return result.config;
}

/**
 * A layer's people as stored: in turn order for a rotation, on one of the
 * pattern's crews for a pattern. Regular hours name their people in each
 * entry, so the layer itself lists nobody.
 */
function checkedMembers(kind: ScheduleLayerKind, config: LayerConfig, members: { userId: string; crew?: string | null }[]): LayerMember[] {
  if (kind === 'recurring') return [];
  const unique = [...new Map(members.map((m) => [m.userId, m])).values()];
  if (kind === 'pattern') {
    const crews = new Set((config as PatternConfig).crews.map((c) => c.id));
    if (unique.some((m) => !m.crew || !crews.has(m.crew))) throw badRequest('Everyone on a pattern must be on one of its crews');
  }
  return unique.map((m, position) => ({ userId: m.userId, position, crew: kind === 'pattern' ? (m.crew ?? null) : null }));
}

/** Everyone a layer puts on shift. */
function peopleIn(kind: ScheduleLayerKind, config: LayerConfig, members: LayerMember[]): string[] {
  if (kind !== 'recurring') return members.map((m) => m.userId);
  const recurring = config as RecurringConfig;
  return [...recurring.entries.map((e) => e.userId), ...recurring.oneOffs.map((s) => s.userId)];
}

/** People a layer puts on shift are on the schedule, so they can swap like anyone on it. */
async function ensureScheduleMembers(client: DbClient, scheduleId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await client.query(
    `INSERT INTO schedule_members (schedule_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [scheduleId, [...new Set(userIds)]],
  );
}

/**
 * When a change takes effect: now, or a moment still to come. A change dated
 * in the past would rewrite shifts already worked, so it is refused.
 */
function effectiveAt(value: string | undefined): Date {
  const now = new Date();
  if (!value) return now;
  const at = new Date(value);
  // A minute's grace for a form that said "now" a moment ago.
  if (at.getTime() < now.getTime() - 60_000) throw badRequest('A change can only take effect from now or later');
  return at < now ? now : at;
}

/** The versions of a layer on this schedule, oldest first, or 404. */
async function lineage(scheduleId: string, lineageId: string) {
  const { rows } = await query<{ id: string; kind: ScheduleLayerKind; config: LayerConfig; effective_from: string }>(
    `SELECT id, kind, config, effective_from FROM schedule_layers
      WHERE schedule_id = $1 AND lineage_id::text = $2 ORDER BY effective_from`,
    [scheduleId, lineageId],
  );
  if (rows.length === 0) throw notFound('Layer not found');
  return rows;
}

const MAX_RANGE_DAYS = 100;

const rangeSchema = z
  .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .refine((r) => new Date(r.to) > new Date(r.from), 'The range must end after it starts')
  .refine(
    (r) => new Date(r.to).getTime() - new Date(r.from).getTime() <= MAX_RANGE_DAYS * 86_400_000,
    `Ask for at most ${MAX_RANGE_DAYS} days at a time`,
  );

export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/workspaces/:id/schedules', async (req) => {
    const { roleId } = await assertWorkspaceAccess(req, req.params.id, 'schedules.view', 'schedules');
    const { rows } = await query<ScheduleSummary>(
      `SELECT ${summaryColumns('$2')}
         FROM schedules s
        WHERE s.workspace_id = $1 AND ${scheduleLevelSql('$2', '$3')} > 0
        ORDER BY lower(s.name)`,
      [req.params.id, req.user!.id, roleId],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/schedules', async (req, reply) => {
    const workspaceId = req.params.id;
    await assertWorkspaceAccess(req, workspaceId, 'schedules.create', 'schedules');
    const input = parse(createScheduleSchema, req.body ?? {});
    const members = dedupe(input.members ?? []);
    await assertWorkspaceMembers(workspaceId, members.map((m) => m.userId));

    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO schedules (workspace_id, name, description, time_zone, color, requires_approval, created_by)
         VALUES ($1, $2, $3, $4, COALESCE($5, '#3b82f6'), $6, $7) RETURNING id`,
        [
          workspaceId,
          input.name,
          input.description ?? '',
          input.timeZone,
          input.color ?? null,
          input.requiresApproval ?? false,
          req.user!.id,
        ],
      );
      if (members.length) await writeMembers(client, rows[0].id, members);
      return rows[0].id;
    });

    scheduleChanged(workspaceId, id);
    reply.status(201);
    return fetchSchedule(await assertScheduleAccess(req, id), req.user!.id);
  });

  app.get<{ Params: { id: string } }>('/schedules/:id', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id);
    return fetchSchedule(access, req.user!.id);
  });

  app.patch<{ Params: { id: string } }>('/schedules/:id', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    const input = parse(updateScheduleSchema, req.body ?? {});
    await query(
      `UPDATE schedules
          SET name = COALESCE($2, name),
              description = COALESCE($3, description),
              time_zone = COALESCE($4, time_zone),
              color = COALESCE($5, color),
              requires_approval = COALESCE($6, requires_approval),
              updated_at = now()
        WHERE id = $1`,
      [
        req.params.id,
        input.name ?? null,
        input.description ?? null,
        input.timeZone ?? null,
        input.color ?? null,
        input.requiresApproval ?? null,
      ],
    );
    scheduleChanged(access.workspaceId, req.params.id);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
    const access = await assertScheduleAccess(req, req.params.id, 'delete');
    // Its layers, overrides, requests and lists go with it.
    await query('DELETE FROM schedules WHERE id = $1', [req.params.id]);
    scheduleChanged(access.workspaceId, req.params.id);
    reply.status(204);
  });

  /** Who is on the schedule, and who manages it, replacing the list. */
  app.put<{ Params: { id: string } }>('/schedules/:id/members', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    const members = dedupe(parse(setScheduleMembersSchema, req.body ?? {}).members);
    await assertWorkspaceMembers(access.workspaceId, members.map((m) => m.userId));
    const kept = new Set(members.map((m) => m.userId));
    const before = await loadMembers(req.params.id);

    await transaction(async (client) => {
      // Someone taken off comes out of its rotations from now on, with their
      // requests, as when they leave the workspace.
      for (const gone of before.filter((m) => !kept.has(m.userId))) {
        await leaveSchedules(client, access.workspaceId, gone.userId, req.params.id);
      }
      if (members.length) await writeMembers(client, req.params.id, members);
    });

    scheduleChanged(access.workspaceId, req.params.id);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  /** The teams and people who may override this schedule's shifts, replacing the list. */
  app.put<{ Params: { id: string } }>('/schedules/:id/override-grants', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'grantOverride');
    const { entries } = parse(setOverrideGrantsSchema, req.body ?? {});
    const userIds = entries.flatMap((e) => (e.userId ? [e.userId] : []));
    const teamIds = [...new Set(entries.flatMap((e) => (e.teamId ? [e.teamId] : [])))];
    await assertWorkspaceMembers(access.workspaceId, userIds);
    if (teamIds.length) {
      const { rows } = await query<{ count: number }>(
        'SELECT count(*)::int AS count FROM teams WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
        [access.workspaceId, teamIds],
      );
      if (rows[0].count !== teamIds.length) throw badRequest('Every team listed must belong to this workspace');
    }

    await transaction(async (client) => {
      await client.query('DELETE FROM schedule_override_grants WHERE schedule_id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO schedule_override_grants (schedule_id, team_id)
         SELECT $1, unnest($2::uuid[])`,
        [req.params.id, teamIds],
      );
      await client.query(
        `INSERT INTO schedule_override_grants (schedule_id, user_id)
         SELECT $1, unnest($2::uuid[])`,
        [req.params.id, [...new Set(userIds)]],
      );
    });

    scheduleChanged(access.workspaceId, req.params.id);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  // --- layers -------------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/schedules/:id/layers', async (req, reply) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    const input = parse(createLayerSchema, req.body ?? {});
    const config = checkedConfig(input.kind, input.config);
    const members = checkedMembers(input.kind, config, input.members ?? []);
    const people = peopleIn(input.kind, config, members);
    await assertWorkspaceMembers(access.workspaceId, people);
    const at = effectiveAt(input.effectiveFrom);

    await transaction(async (client) => {
      // A new layer goes on top.
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO schedule_layers (schedule_id, lineage_id, kind, name, position, config, effective_from, created_by)
         VALUES ($1, gen_random_uuid(), $2, $3,
                 (SELECT COALESCE(max(position) + 1, 0) FROM schedule_layers WHERE schedule_id = $1),
                 $4, $5, $6)
         RETURNING id`,
        [req.params.id, input.kind, input.name, JSON.stringify(config), at, req.user!.id],
      );
      await writeLayerMembers(client, rows[0].id, members);
      await ensureScheduleMembers(client, req.params.id, people);
    });

    scheduleChanged(access.workspaceId, req.params.id);
    reply.status(201);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  /** Changes a layer from a moment on, keeping how it was before then. */
  app.patch<{ Params: { id: string; lineageId: string } }>('/schedules/:id/layers/:lineageId', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    const versions = await lineage(req.params.id, req.params.lineageId);
    const input = parse(updateLayerSchema, req.body ?? {});
    const { kind } = versions[0];
    const config = input.config === undefined ? undefined : checkedConfig(kind, input.config);
    const members = input.members && checkedMembers(kind, config ?? versions[versions.length - 1].config, input.members);
    const people = peopleIn(kind, config ?? versions[versions.length - 1].config, members ?? []);
    await assertWorkspaceMembers(access.workspaceId, people);
    const at = effectiveAt(input.effectiveFrom);

    await transaction(async (client) => {
      await reviseLineage(client, req.params.lineageId, at, () => ({ name: input.name, config, members }), req.user!.id);
      await ensureScheduleMembers(client, req.params.id, people);
    });

    scheduleChanged(access.workspaceId, req.params.id);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  /** Ends a layer now. Its past shifts stay; one that never started is gone. */
  app.delete<{ Params: { id: string; lineageId: string } }>('/schedules/:id/layers/:lineageId', async (req, reply) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    await lineage(req.params.id, req.params.lineageId);
    await transaction(async (client) => {
      await client.query(`DELETE FROM schedule_layers WHERE lineage_id = $1 AND effective_from >= now()`, [
        req.params.lineageId,
      ]);
      await client.query(
        `UPDATE schedule_layers SET effective_until = now()
          WHERE lineage_id = $1 AND (effective_until IS NULL OR effective_until > now())`,
        [req.params.lineageId],
      );
    });
    scheduleChanged(access.workspaceId, req.params.id);
    reply.status(204);
  });

  /** Which layers win over which, highest first. */
  app.put<{ Params: { id: string } }>('/schedules/:id/layers/order', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id, 'edit');
    const { lineageIds } = parse(orderLayersSchema, req.body ?? {});
    await query(
      `UPDATE schedule_layers l SET position = x.position
         FROM unnest($2::uuid[], $3::int[]) AS x(lineage_id, position)
        WHERE l.schedule_id = $1 AND l.lineage_id = x.lineage_id`,
      [req.params.id, lineageIds, lineageIds.map((_, i) => lineageIds.length - 1 - i)],
    );
    scheduleChanged(access.workspaceId, req.params.id);
    return fetchSchedule(await assertScheduleAccess(req, req.params.id), req.user!.id);
  });

  // --- shifts -------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/schedules/:id/shifts', async (req) => {
    const access = await assertScheduleAccess(req, req.params.id);
    const { from, to } = parse(rangeSchema, req.query);
    const { rows } = await query<{ time_zone: string }>('SELECT time_zone FROM schedules WHERE id = $1', [access.scheduleId]);
    return scheduleShifts({ id: access.scheduleId, timeZone: rows[0].time_zone }, from, to);
  });

  /**
   * The caller's own shifts across every schedule they can see: those they are
   * on, and any where an override put them without making them a member.
   */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/workspaces/:id/my-shifts', async (req) => {
    const { roleId } = await assertWorkspaceAccess(req, req.params.id, 'schedules.view', 'schedules');
    const { from, to } = parse(rangeSchema, req.query);
    const me = req.user!.id;
    const { rows } = await query<{ id: string; name: string; color: string; time_zone: string }>(
      `SELECT s.id, s.name, s.color, s.time_zone
         FROM schedules s
        WHERE s.workspace_id = $1 AND ${scheduleLevelSql('$2', '$3')} > 0
          AND (EXISTS (SELECT 1 FROM schedule_members sm WHERE sm.schedule_id = s.id AND sm.user_id = $2)
            OR EXISTS (SELECT 1 FROM schedule_overrides o
                        WHERE o.schedule_id = s.id AND o.user_id = $2 AND o.starts_at < $5 AND o.ends_at > $4))`,
      [req.params.id, me, roleId, from, to],
    );
    const shifts: MyShift[] = [];
    for (const schedule of rows) {
      const resolved = await scheduleShifts({ id: schedule.id, timeZone: schedule.time_zone }, from, to);
      for (const shift of resolved.shifts) {
        if (shift.userId !== me) continue;
        shifts.push({ ...shift, scheduleId: schedule.id, scheduleName: schedule.name, color: schedule.color, timeZone: schedule.time_zone });
      }
    }
    shifts.sort((a, b) => a.start.localeCompare(b.start));
    return { from, to, shifts };
  });
};
