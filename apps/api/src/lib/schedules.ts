import { DateTime } from 'luxon';
import {
  resolveLayers,
  resolveSchedule,
  shiftsAt,
  type LayerConfig,
  type LayerMember,
  type MyShift,
  type RecurringConfig,
  type ResolverOverride,
  type ScheduleLayer,
  type ScheduleLayerKind,
  type ScheduleShifts,
} from '@paradocs/shared';
import { query, type DbClient } from '../db/pool.js';
import { scheduleLevelSql } from './access.js';
import { appEnabledSql } from './apps.js';
import { publishToWorkspace } from '../chat/hub.js';

/**
 * Changing schedules without rewriting their past.
 *
 * A layer is stored as versions, each in effect over [effective_from,
 * effective_until). A change made from some moment ends the version running
 * then and starts a new one from that moment, so shifts before it stay as they
 * were. Versions that only start later are changed where they stand.
 */

export interface LayerRow {
  id: string;
  schedule_id: string;
  lineage_id: string;
  kind: ScheduleLayerKind;
  name: string;
  position: number;
  config: LayerConfig;
  effective_from: string;
  effective_until: string | null;
}

export interface LayerRevision {
  name?: string;
  config?: LayerConfig;
  members?: LayerMember[];
}

async function layerMembers(client: DbClient, layerId: string): Promise<LayerMember[]> {
  const { rows } = await client.query<LayerMember>(
    'SELECT user_id AS "userId", position, crew FROM schedule_layer_members WHERE layer_id = $1 ORDER BY position',
    [layerId],
  );
  return rows;
}

export async function writeLayerMembers(client: DbClient, layerId: string, members: LayerMember[]): Promise<void> {
  await client.query('DELETE FROM schedule_layer_members WHERE layer_id = $1', [layerId]);
  if (members.length === 0) return;
  await client.query(
    `INSERT INTO schedule_layer_members (layer_id, user_id, position, crew)
     SELECT $1, x.user_id, x.position, x.crew
       FROM unnest($2::uuid[], $3::int[], $4::text[]) AS x(user_id, position, crew)`,
    [layerId, members.map((m) => m.userId), members.map((_, i) => i), members.map((m) => m.crew)],
  );
}

/**
 * Applies `revise` to every version of a layer's lineage still in effect at
 * `at`, ending the one running then and carrying on with a new version.
 */
export async function reviseLineage(
  client: DbClient,
  lineageId: string,
  at: Date,
  revise: (current: { config: LayerConfig; members: LayerMember[]; name: string }) => LayerRevision,
  userId: string | null,
): Promise<void> {
  const { rows } = await client.query<LayerRow>(
    `SELECT id, schedule_id, lineage_id, kind, name, position, config, effective_from, effective_until
       FROM schedule_layers
      WHERE lineage_id = $1 AND (effective_until IS NULL OR effective_until > $2)
      ORDER BY effective_from
      FOR UPDATE`,
    [lineageId, at],
  );
  for (const row of rows) {
    const members = await layerMembers(client, row.id);
    const next = revise({ config: row.config, members, name: row.name });
    const config = next.config ?? row.config;
    const name = next.name ?? row.name;
    if (new Date(row.effective_from) >= at) {
      await client.query('UPDATE schedule_layers SET config = $2, name = $3 WHERE id = $1', [
        row.id,
        JSON.stringify(config),
        name,
      ]);
      if (next.members) await writeLayerMembers(client, row.id, next.members);
      continue;
    }
    await client.query('UPDATE schedule_layers SET effective_until = $2 WHERE id = $1', [row.id, at]);
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO schedule_layers
         (schedule_id, lineage_id, kind, name, position, config, effective_from, effective_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [row.schedule_id, row.lineage_id, row.kind, name, row.position, JSON.stringify(config), at, row.effective_until, userId],
    );
    await writeLayerMembers(client, created[0].id, next.members ?? members);
  }
}


/** Tells everyone with the workspace open that a schedule, or anything on it, changed. */
export function scheduleChanged(workspaceId: string, scheduleId: string): void {
  publishToWorkspace(workspaceId, { type: 'schedules.changed', workspaceId, scheduleId });
}

/**
 * Takes someone off every schedule in a workspace, or only `scheduleId`, from
 * now on: out of its rotations, crews and regular hours, off its member list
 * and its override grants, with their open requests cancelled and their place
 * on others' dropped. Their past shifts stay where they were.
 */
export async function leaveSchedules(
  client: DbClient,
  workspaceId: string,
  userId: string,
  scheduleId?: string,
): Promise<void> {
  const now = new Date();
  const only = scheduleId ?? null;
  const { rows: lineages } = await client.query<{ lineage_id: string; time_zone: string }>(
    `SELECT DISTINCT l.lineage_id, s.time_zone
       FROM schedule_layers l JOIN schedules s ON s.id = l.schedule_id
      WHERE s.workspace_id = $1 AND ($4::uuid IS NULL OR s.id = $4)
        AND (l.effective_until IS NULL OR l.effective_until > $3)
        AND (EXISTS (SELECT 1 FROM schedule_layer_members m WHERE m.layer_id = l.id AND m.user_id = $2)
          OR l.config::text LIKE '%' || $2::text || '%')`,
    [workspaceId, userId, now, only],
  );
  for (const { lineage_id, time_zone } of lineages) {
    await reviseLineage(
      client,
      lineage_id,
      now,
      ({ config, members }) => {
        const kept = members.filter((m) => m.userId !== userId);
        if (!('entries' in config)) return { members: kept };
        // Hours end with the day before; one-off shifts still to come go.
        const local = DateTime.fromJSDate(now, { zone: time_zone });
        const last = local.minus({ days: 1 }).toISODate()!;
        const stamp = local.toFormat("yyyy-MM-dd'T'HH:mm");
        const recurring = config as RecurringConfig;
        return {
          members: kept,
          config: {
            entries: recurring.entries.map((e) =>
              e.userId === userId && (!e.until || e.until > last) ? { ...e, until: last } : e,
            ),
            oneOffs: recurring.oneOffs.filter((s) => s.userId !== userId || s.end <= stamp),
          },
        };
      },
      null,
    );
  }
  const inWorkspace = 'SELECT id FROM schedules WHERE workspace_id = $1 AND ($3::uuid IS NULL OR id = $3)';
  await client.query(`DELETE FROM schedule_members WHERE user_id = $2 AND schedule_id IN (${inWorkspace})`, [
    workspaceId,
    userId,
    only,
  ]);
  await client.query(`DELETE FROM schedule_override_grants WHERE user_id = $2 AND schedule_id IN (${inWorkspace})`, [
    workspaceId,
    userId,
    only,
  ]);
  await client.query(
    `DELETE FROM schedule_overrides WHERE user_id = $2 AND starts_at > now() AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId, only],
  );
  await client.query(
    `UPDATE schedule_requests SET status = 'cancelled', updated_at = now()
      WHERE requester_id = $2 AND status IN ('open', 'accepted') AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId, only],
  );
  await client.query(
    `DELETE FROM schedule_request_candidates c USING schedule_requests r
      WHERE r.id = c.request_id AND c.user_id = $2 AND r.schedule_id IN (${inWorkspace})`,
    [workspaceId, userId, only],
  );
  // A request they took but that still waits for approval goes back to open.
  await client.query(
    `UPDATE schedule_requests SET status = 'open', accepted_by = NULL, accepted_at = NULL,
            swap_starts_at = NULL, swap_ends_at = NULL, updated_at = now()
      WHERE accepted_by = $2 AND status = 'accepted' AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId, only],
  );
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


/** The overrides on a schedule reaching into [from, to), oldest first, as the resolver takes them. */
export async function loadOverrides(scheduleId: string, from: string, to: string): Promise<ResolverOverride[]> {
  const { rows } = await query<ResolverOverride>(
    `SELECT id, user_id AS "userId", replaced_user_id AS "replacedUserId", starts_at AS "startsAt", ends_at AS "endsAt"
       FROM schedule_overrides
      WHERE schedule_id = $1 AND starts_at < $3 AND ends_at > $2
      ORDER BY created_at, id`,
    [scheduleId, from, to],
  );
  return rows;
}

/**
 * Who is on a schedule over [from, to), and each layer's own shifts: what the
 * views, My shifts, reminders and the calendar feed all ask.
 */
export async function scheduleShifts(
  schedule: { id: string; timeZone: string },
  from: string,
  to: string,
  layers?: ScheduleLayer[],
): Promise<ScheduleShifts> {
  const all = layers ?? (await loadLayers(schedule.id));
  const overrides = await loadOverrides(schedule.id, from, to);
  const shifts = resolveSchedule(schedule, all, overrides, from, to);
  const rows = resolveLayers(schedule, all, from, to);
  // Each row is named after the layer's latest version.
  const latest = new Map<string, ScheduleLayer>();
  for (const layer of all) {
    const seen = latest.get(layer.lineageId);
    if (!seen || seen.effectiveFrom < layer.effectiveFrom) latest.set(layer.lineageId, layer);
  }
  return {
    from,
    to,
    shifts,
    layers: [...latest.values()]
      .sort((a, b) => b.position - a.position)
      .map((layer) => ({ lineageId: layer.lineageId, name: layer.name, kind: layer.kind, shifts: rows.get(layer.lineageId) ?? [] })),
  };
}

/**
 * Who is on a schedule at `at`, in the order the resolver gives, kept to the
 * workspace's members: someone who has left may still be on a layer. Nobody
 * when the schedule is gone, is in another workspace, or Schedules is off.
 * It is the system asking, so whose eyes the schedule is hidden from is not
 * what decides it.
 */
export async function onCallAt(scheduleId: string, workspaceId: string, at = new Date()): Promise<string[]> {
  const { rows } = await query<{ time_zone: string }>(
    `SELECT s.time_zone FROM schedules s WHERE s.id = $1 AND s.workspace_id = $2 AND ${appEnabledSql('s.workspace_id', 'schedules')}`,
    [scheduleId, workspaceId],
  );
  if (!rows[0]) return [];
  const from = at.toISOString();
  const to = new Date(at.getTime() + 1).toISOString();
  const overrides = await loadOverrides(scheduleId, from, to);
  const on = shiftsAt(resolveSchedule({ timeZone: rows[0].time_zone }, await loadLayers(scheduleId), overrides, from, to), from);
  const userIds = [...new Set(on.map((shift) => shift.userId))];
  if (userIds.length === 0) return [];
  const { rows: members } = await query<{ user_id: string }>(
    'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])',
    [workspaceId, userIds],
  );
  const kept = new Set(members.map((m) => m.user_id));
  return userIds.filter((id) => kept.has(id));
}

/**
 * Requests nobody answered in time expire when the shift starts. Done when
 * requests are read, and by the reminder sweep, so nothing waits on a timer.
 */
export async function expireRequests(scheduleId?: string): Promise<void> {
  await query(
    `UPDATE schedule_requests SET status = 'expired', updated_at = now()
      WHERE status IN ('open', 'accepted') AND starts_at <= now() AND ($1::uuid IS NULL OR schedule_id = $1)`,
    [scheduleId ?? null],
  );
}

/**
 * Someone's own shifts across the schedules in a workspace they can see: those
 * they are on, and any where an override put them without making them a
 * member. `scheduleId` narrows it to one schedule's shifts, everyone's.
 */
export async function shiftsOf(
  workspaceId: string,
  userId: string,
  roleId: string,
  from: string,
  to: string,
  scheduleId?: string,
): Promise<MyShift[]> {
  const { rows } = await query<{ id: string; name: string; color: string; time_zone: string }>(
    `SELECT s.id, s.name, s.color, s.time_zone
       FROM schedules s
      WHERE s.workspace_id = $1 AND ${scheduleLevelSql('$2', '$3')} > 0
        AND ($6::uuid IS NOT NULL AND s.id = $6
          OR $6::uuid IS NULL AND (
               EXISTS (SELECT 1 FROM schedule_members sm WHERE sm.schedule_id = s.id AND sm.user_id = $2)
            OR EXISTS (SELECT 1 FROM schedule_overrides o
                        WHERE o.schedule_id = s.id AND o.user_id = $2 AND o.starts_at < $5 AND o.ends_at > $4)))`,
    [workspaceId, userId, roleId, from, to, scheduleId ?? null],
  );
  const shifts: MyShift[] = [];
  for (const schedule of rows) {
    const resolved = await scheduleShifts({ id: schedule.id, timeZone: schedule.time_zone }, from, to);
    for (const shift of resolved.shifts) {
      if (!scheduleId && shift.userId !== userId) continue;
      shifts.push({ ...shift, scheduleId: schedule.id, scheduleName: schedule.name, color: schedule.color, timeZone: schedule.time_zone });
    }
  }
  return shifts.sort((a, b) => a.start.localeCompare(b.start));
}
