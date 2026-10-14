import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('overrides', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let outsider: TestUser;
  let scheduleId: string;
  const day = (offset: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    outsider = await api.register('Oz');
    for (const user of [ann, ben, outsider]) await api.join(user, owner.workspaceId, 'Editor');
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name: 'On call', timeZone: 'UTC' });
    scheduleId = body.id;
    await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Primary',
      config: { start: '2026-01-05T00:00', length: { unit: 'weeks', count: 52 } },
      members: [{ userId: ann.id }, { userId: ben.id }],
    });
    // Counting from long ago, so whoever the rotation says is on, is.
    await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [scheduleId]);
  });

  afterAll(() => api.close());

  const onAt = async (time: string, user: TestUser = owner) => {
    const from = new Date(Date.parse(time) - 3_600_000).toISOString();
    const to = new Date(Date.parse(time) + 3_600_000).toISOString();
    const { body } = await api.call(user, 'GET', `/schedules/${scheduleId}/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return body.shifts.filter((s: { start: string; end: string }) => s.start <= time && s.end > time);
  };

  it('needs the override permission, whatever the UI shows', async () => {
    const [shift] = await onAt(day(1, 12));
    const body = { userId: ben.id, replacedUserId: shift.userId, startsAt: day(1, 10), endsAt: day(1, 14) };
    // Editors do not override by default.
    expect((await api.call(ann, 'POST', `/schedules/${scheduleId}/overrides`, body)).status).toBe(403);
  });

  it('splits a shift for an override on part of it, and puts back the original when removed', async () => {
    const [shift] = await onAt(day(1, 12));
    const original = shift.userId;
    const made = await api.call(owner, 'POST', `/schedules/${scheduleId}/overrides`, {
      userId: outsider.id,
      replacedUserId: original,
      startsAt: day(1, 10),
      endsAt: day(1, 14),
      note: 'Sick day',
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ userName: 'Oz', source: 'manual', note: 'Sick day' });

    const [during] = await onAt(day(1, 12));
    expect(during).toMatchObject({ userId: outsider.id, overriddenFrom: original });
    expect((await onAt(day(1, 9)))[0].userId).toBe(original);
    expect((await onAt(day(1, 15)))[0].userId).toBe(original);

    // Oz is not on the schedule, but sees the shift in My shifts.
    const mine = await api.call(outsider, 'GET', `/workspaces/${owner.workspaceId}/my-shifts?from=${encodeURIComponent(day(0, 0))}&to=${encodeURIComponent(day(3, 0))}`);
    expect(mine.body.shifts).toHaveLength(1);
    const { body: schedule } = await api.call(owner, 'GET', `/schedules/${scheduleId}`);
    expect(schedule.members.map((m: { userId: string }) => m.userId)).not.toContain(outsider.id);

    expect((await api.call(owner, 'DELETE', `/schedules/${scheduleId}/overrides/${made.body.id}`)).status).toBe(204);
    expect((await onAt(day(1, 12)))[0].userId).toBe(original);
  });

  it('refuses someone who cannot see the schedule', async () => {
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, {
      access: 'deny',
      entries: [{ userId: outsider.id, permission: 'none' }],
    });
    const refused = await api.call(owner, 'POST', `/schedules/${scheduleId}/overrides`, {
      userId: outsider.id,
      replacedUserId: null,
      startsAt: day(2, 10),
      endsAt: day(2, 14),
    });
    expect(refused.status).toBe(400);
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'open' });
  });

  it('lets "Can override" on the schedule do it', async () => {
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/override-grants`, { entries: [{ userId: ann.id }] });
    const made = await api.call(ann, 'POST', `/schedules/${scheduleId}/overrides`, {
      userId: ann.id,
      replacedUserId: null,
      startsAt: day(2, 10),
      endsAt: day(2, 14),
    });
    expect(made.status).toBe(201);
    const listed = await api.call(owner, 'GET', `/schedules/${scheduleId}/overrides?from=${encodeURIComponent(day(0, 0))}&to=${encodeURIComponent(day(5, 0))}`);
    expect(listed.body).toHaveLength(1);
  });
});
