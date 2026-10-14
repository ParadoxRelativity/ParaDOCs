import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('leaving a workspace takes someone off its schedules', () => {
  let api: Api;
  let owner: TestUser;
  let bea: TestUser;
  let cal: TestUser;
  let scheduleId: string;

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    bea = await api.register('Bea');
    cal = await api.register('Cal');
    await api.join(bea, owner.workspaceId, 'Editor');
    await api.join(cal, owner.workspaceId, 'Editor');
    [{ id: scheduleId }] = await api.sql<{ id: string }>(
      `INSERT INTO schedules (workspace_id, name, time_zone) VALUES ($1, 'On call', 'UTC') RETURNING id`,
      [owner.workspaceId],
    );
    await api.sql(
      `INSERT INTO schedule_members (schedule_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [scheduleId, bea.id, cal.id],
    );
    const [{ id: layerId }] = await api.sql<{ id: string }>(
      `INSERT INTO schedule_layers (schedule_id, lineage_id, kind, name, config, effective_from)
       VALUES ($1, gen_random_uuid(), 'rotation', 'Primary', $2, '2020-01-01T00:00:00Z') RETURNING id`,
      [scheduleId, JSON.stringify({ start: '2020-01-06T09:00', length: { unit: 'weeks', count: 1 }, restrictions: [] })],
    );
    await api.sql(
      `INSERT INTO schedule_layer_members (layer_id, user_id, position) VALUES ($1, $2, 0), ($1, $3, 1)`,
      [layerId, bea.id, cal.id],
    );
  });

  afterAll(() => api.close());

  it('ends the rotation version they were in and carries on without them', async () => {
    const removed = await api.call(owner, 'DELETE', `/workspaces/${owner.workspaceId}/members/${bea.id}`);
    expect(removed.status).toBe(204);

    const versions = await api.sql<{ id: string; effective_until: string | null }>(
      'SELECT id, effective_until FROM schedule_layers WHERE schedule_id = $1 ORDER BY effective_from',
      [scheduleId],
    );
    expect(versions).toHaveLength(2);
    expect(versions[0].effective_until).not.toBeNull();
    expect(versions[1].effective_until).toBeNull();

    const people = async (layerId: string) =>
      (await api.sql<{ user_id: string }>('SELECT user_id FROM schedule_layer_members WHERE layer_id = $1', [layerId])).map(
        (r) => r.user_id,
      );
    // The past keeps them; from now on it is only Cal.
    expect((await people(versions[0].id)).sort()).toEqual([bea.id, cal.id].sort());
    expect(await people(versions[1].id)).toEqual([cal.id]);

    const members = await api.sql<{ user_id: string }>('SELECT user_id FROM schedule_members WHERE schedule_id = $1', [
      scheduleId,
    ]);
    expect(members.map((m) => m.user_id)).toEqual([cal.id]);
  });
});
