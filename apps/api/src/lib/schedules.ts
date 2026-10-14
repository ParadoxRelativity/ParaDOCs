import { DateTime } from 'luxon';
import type { LayerConfig, LayerMember, RecurringConfig, ScheduleLayerKind } from '@paradocs/shared';
import type { DbClient } from '../db/pool.js';

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

async function writeMembers(client: DbClient, layerId: string, members: LayerMember[]): Promise<void> {
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
      if (next.members) await writeMembers(client, row.id, next.members);
      continue;
    }
    await client.query('UPDATE schedule_layers SET effective_until = $2 WHERE id = $1', [row.id, at]);
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO schedule_layers
         (schedule_id, lineage_id, kind, name, position, config, effective_from, effective_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [row.schedule_id, row.lineage_id, row.kind, name, row.position, JSON.stringify(config), at, row.effective_until, userId],
    );
    await writeMembers(client, created[0].id, next.members ?? members);
  }
}


/**
 * Takes someone off every schedule in a workspace from now on: out of its
 * rotations, crews and regular hours, off its member list and its override
 * grants, with their open requests cancelled and their place on others'
 * dropped. Their past shifts stay where they were.
 */
export async function leaveSchedules(client: DbClient, workspaceId: string, userId: string): Promise<void> {
  const now = new Date();
  const { rows: lineages } = await client.query<{ lineage_id: string; time_zone: string }>(
    `SELECT DISTINCT l.lineage_id, s.time_zone
       FROM schedule_layers l JOIN schedules s ON s.id = l.schedule_id
      WHERE s.workspace_id = $1 AND (l.effective_until IS NULL OR l.effective_until > $3)
        AND (EXISTS (SELECT 1 FROM schedule_layer_members m WHERE m.layer_id = l.id AND m.user_id = $2)
          OR l.config::text LIKE '%' || $2::text || '%')`,
    [workspaceId, userId, now],
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
  const inWorkspace = 'SELECT id FROM schedules WHERE workspace_id = $1';
  await client.query(`DELETE FROM schedule_members WHERE user_id = $2 AND schedule_id IN (${inWorkspace})`, [
    workspaceId,
    userId,
  ]);
  await client.query(`DELETE FROM schedule_override_grants WHERE user_id = $2 AND schedule_id IN (${inWorkspace})`, [
    workspaceId,
    userId,
  ]);
  await client.query(
    `DELETE FROM schedule_overrides WHERE user_id = $2 AND starts_at > now() AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId],
  );
  await client.query(
    `UPDATE schedule_requests SET status = 'cancelled', updated_at = now()
      WHERE requester_id = $2 AND status IN ('open', 'accepted') AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId],
  );
  await client.query(
    `DELETE FROM schedule_request_candidates c USING schedule_requests r
      WHERE r.id = c.request_id AND c.user_id = $2 AND r.schedule_id IN (${inWorkspace})`,
    [workspaceId, userId],
  );
  // A request they took but that still waits for approval goes back to open.
  await client.query(
    `UPDATE schedule_requests SET status = 'open', accepted_by = NULL, accepted_at = NULL,
            swap_starts_at = NULL, swap_ends_at = NULL, updated_at = now()
      WHERE accepted_by = $2 AND status = 'accepted' AND schedule_id IN (${inWorkspace})`,
    [workspaceId, userId],
  );
}
