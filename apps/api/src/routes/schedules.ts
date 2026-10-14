import type { FastifyPluginAsync } from 'fastify';
import {
  createScheduleSchema,
  setOverrideGrantsSchema,
  setScheduleMembersSchema,
  updateScheduleSchema,
  type OverrideGrant,
  type Schedule,
  type ScheduleLayer,
  type ScheduleMember,
  type ScheduleSummary,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { assertScheduleAccess, scheduleLevelSql, type ScheduleAccess } from '../lib/access.js';
import { badRequest, parse } from '../lib/http.js';
import { leaveSchedules, scheduleChanged } from '../lib/schedules.js';
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

/** Every version of every layer of a schedule, with its people. */
export async function loadLayers(scheduleId: string): Promise<ScheduleLayer[]> {
  const { rows } = await query<ScheduleLayer>(
    `SELECT l.id, l.lineage_id AS "lineageId", l.kind, l.name, l.position, l.config,
            l.effective_from AS "effectiveFrom", l.effective_until AS "effectiveUntil",
            COALESCE((SELECT json_agg(json_build_object('userId', lm.user_id, 'position', lm.position, 'crew', lm.crew)
                                      ORDER BY lm.position)
                        FROM schedule_layer_members lm WHERE lm.layer_id = l.id), '[]'::json) AS members
       FROM schedule_layers l
      WHERE l.schedule_id = $1
      ORDER BY l.position DESC, l.effective_from`,
    [scheduleId],
  );
  return rows;
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
};
