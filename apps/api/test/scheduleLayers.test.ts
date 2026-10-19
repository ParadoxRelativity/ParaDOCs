import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('rotations', () => {
  let api: Api;
  let owner: TestUser;
  let people: TestUser[];
  let viewer: TestUser;
  let scheduleId: string;

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    people = [];
    for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) {
      const user = await api.register(name);
      await api.join(user, owner.workspaceId, 'Editor');
      people.push(user);
    }
    viewer = await api.register('Vic');
    await api.join(viewer, owner.workspaceId, 'Viewer');
    const made = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, {
      name: 'On call',
      timeZone: 'America/New_York',
    });
    scheduleId = made.body.id;
  });

  afterAll(() => api.close());

  const shiftsAt = async (time: string) => {
    const from = new Date(new Date(time).getTime() - 1).toISOString();
    const to = new Date(new Date(time).getTime() + 1).toISOString();
    const { body } = await api.call(owner, 'GET', `/schedules/${scheduleId}/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return body.shifts
      .filter((s: { start: string; end: string }) => s.start <= new Date(time).toISOString() && s.end > new Date(time).toISOString())
      .map((s: { userId: string }) => people.find((p) => p.id === s.userId)?.name);
  };

  it('hands off weekly on Monday at 09:00, across daylight saving', async () => {
    const created = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Primary',
      config: { start: '2026-01-05T09:00', length: { unit: 'weeks', count: 1 } },
      members: people.map((p) => ({ userId: p.id })),
      effectiveFrom: '2026-01-01T00:00:00Z',
    });
    // Only from now on: a layer cannot start in the past.
    expect(created.status).toBe(400);

    const ok = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Primary',
      config: { start: '2026-01-05T09:00', length: { unit: 'weeks', count: 1 } },
      members: people.map((p) => ({ userId: p.id })),
    });
    expect(ok.status).toBe(201);
    // Everyone in the rotation is on the schedule.
    expect(ok.body.memberCount).toBe(4);
    // The layer counts from when it was made, so ask about a week ahead.
    await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [scheduleId]);

    expect(await shiftsAt('2026-01-05T15:00:00Z')).toEqual(['Ann']);
    expect(await shiftsAt('2026-03-09T12:59:00Z')).toEqual(['Ann']);
    // 09:00 EDT is 13:00 UTC, after the clocks went forward.
    expect(await shiftsAt('2026-03-09T13:00:00Z')).toEqual(['Ben']);
    expect(await shiftsAt('2026-11-02T14:00:00Z')).toEqual([people[(43 % 4)].name]);
  });

  it('changes a rotation only from when the change takes effect', async () => {
    const { body: schedule } = await api.call(owner, 'GET', `/schedules/${scheduleId}`);
    const lineageId = schedule.layers[0].lineageId;
    const takesEffect = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const changed = await api.call(owner, 'PATCH', `/schedules/${scheduleId}/layers/${lineageId}`, {
      members: [...people].reverse().map((p) => ({ userId: p.id })),
      effectiveFrom: takesEffect,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.layers).toHaveLength(2);

    // Before: as it was.
    expect(await shiftsAt('2026-01-05T15:00:00Z')).toEqual(['Ann']);
    // After: the reversed order. The turn index is the same; the person differs.
    const versions = changed.body.layers;
    const after = versions.find((v: { effectiveFrom: string }) => v.effectiveFrom === new Date(takesEffect).toISOString());
    expect(after.members[0].userId).toBe(people[3].id);
    // A Wednesday noon five weeks on: whose turn it is in the new order.
    const later = new Date(Date.now() + 35 * 86_400_000);
    const turn = Math.floor((later.getTime() - Date.parse('2026-01-05T14:00:00Z')) / (7 * 86_400_000));
    const reversed = [...people].reverse().map((p) => p.name);
    const [name] = await shiftsAt(later.toISOString());
    // Within an hour of a handoff daylight saving can move it; the turn either side is fine then.
    expect([reversed[turn % 4], reversed[(turn + 3) % 4]]).toContain(name);
  });

  it('only lets editors and managers change layers', async () => {
    const { body: schedule } = await api.call(owner, 'GET', `/schedules/${scheduleId}`);
    const lineageId = schedule.layers[0].lineageId;
    expect((await api.call(viewer, 'PATCH', `/schedules/${scheduleId}/layers/${lineageId}`, { name: 'X' })).status).toBe(403);
    expect(
      (await api.call(viewer, 'POST', `/schedules/${scheduleId}/layers`, { kind: 'rotation', name: 'X', config: {} })).status,
    ).toBe(403);
  });

  it('refuses a rotation that is not well formed', async () => {
    const bad = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Broken',
      config: { start: 'tomorrow', length: { unit: 'weeks', count: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error ?? bad.body.message).toMatch(/date and time/);
  });

  it('lets a higher layer win, and reorders layers', async () => {
    const secondary = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Business hours',
      config: {
        start: '2026-01-05T00:00',
        length: { unit: 'weeks', count: 1 },
        restrictions: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
      },
      members: [{ userId: viewer.id }],
    });
    expect(secondary.status).toBe(201);
    const lineages = [...new Set(secondary.body.layers.map((l: { lineageId: string }) => l.lineageId))] as string[];
    expect(secondary.body.layers[0].name).toBe('Business hours');
    const reordered = await api.call(owner, 'PUT', `/schedules/${scheduleId}/layers/order`, { lineageIds: [...lineages].reverse() });
    expect(reordered.body.layers[0].name).toBe('Primary');
  });

  it('ends a layer without losing its past', async () => {
    const { body: schedule } = await api.call(owner, 'GET', `/schedules/${scheduleId}`);
    const primary = schedule.layers.find((l: { name: string }) => l.name === 'Primary').lineageId;
    expect((await api.call(owner, 'DELETE', `/schedules/${scheduleId}/layers/${primary}`)).status).toBe(204);
    expect(await shiftsAt('2026-01-05T15:00:00Z')).toEqual(['Ann']);
  });

  it('keeps everyone on a pattern on one of its crews', async () => {
    const config = {
      start: '2026-03-01',
      shiftTypes: [{ id: 'day', name: 'Day', start: '07:00', end: '19:00' }],
      cycle: ['day', null],
      crews: [{ id: 'a', name: 'A', offset: 0 }],
    };
    const off = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'pattern',
      name: 'Plant',
      config,
      members: [{ userId: people[0].id, crew: 'b' }],
    });
    expect(off.status).toBe(400);
    const badCycle = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'pattern',
      name: 'Plant',
      config: { ...config, cycle: ['night'] },
    });
    expect(badCycle.status).toBe(400);
    const ok = await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'pattern',
      name: 'Plant',
      config,
      members: [{ userId: people[0].id, crew: 'a' }],
    });
    expect(ok.status).toBe(201);
  });

  it('holds regular hours and one-off shifts, putting their people on the schedule', async () => {
    const { body: made } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name: 'Front desk', timeZone: 'UTC' });
    const created = await api.call(owner, 'POST', `/schedules/${made.id}/layers`, {
      kind: 'recurring',
      name: 'Regular hours',
      config: {
        entries: [{ id: 'e1', userId: people[1].id, days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '17:00', label: 'Front desk' }],
        oneOffs: [{ id: 'o1', userId: people[2].id, start: '2030-01-01T10:00', end: '2030-01-01T14:00' }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual([people[1].id, people[2].id].sort());

    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(12, 0, 0, 0);
    const from = new Date(tomorrow.getTime() - 3_600_000).toISOString();
    const to = new Date(tomorrow.getTime() + 3_600_000).toISOString();
    const { body } = await api.call(owner, 'GET', `/schedules/${made.id}/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(body.shifts).toEqual([expect.objectContaining({ userId: people[1].id, label: 'Front desk' })]);

    const missing = await api.call(owner, 'POST', `/schedules/${made.id}/layers`, {
      kind: 'recurring',
      name: 'Broken',
      config: { entries: [{ id: 'e1', userId: '', days: [1], start: '09:00', end: '17:00' }] },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error ?? missing.body.message).toMatch(/Choose who works/);
  });
});
