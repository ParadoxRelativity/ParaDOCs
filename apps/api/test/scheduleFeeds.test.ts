import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('calendar feeds', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let scheduleId: string;

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    for (const user of [ann, ben]) await api.join(user, owner.workspaceId, 'Editor');
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name: 'On call, nights', timeZone: 'UTC' });
    scheduleId = body.id;
    await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Primary',
      config: { start: '2026-01-01T00:00', length: { unit: 'days', count: 1 } },
      members: [ann, ben].map((u) => ({ userId: u.id })),
    });
    await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [scheduleId]);
  });

  afterAll(() => api.close());

  const feedPath = (url: string) => url.slice(url.indexOf('/api/'));
  const read = async (url: string) => api.call(null, 'GET', feedPath(url));

  it('serves my shifts as iCal to whoever has the address', async () => {
    const made = await api.call(ann, 'POST', `/workspaces/${owner.workspaceId}/calendar-feed`);
    expect(made.body.url).toMatch(/\/api\/calendar-feeds\/.+\.ics$/);
    const feed = await read(made.body.url);
    expect(feed.status).toBe(200);
    expect(feed.body).toContain('BEGIN:VCALENDAR');
    expect(feed.body).toContain('SUMMARY:On call\\, nights');
    // Ann's days only: about every other day for 210 days.
    const events = feed.body.match(/BEGIN:VEVENT/g)?.length ?? 0;
    expect(events).toBeGreaterThan(90);
    expect(events).toBeLessThan(120);
    // Shown once: asking again gives only the hint.
    const status = await api.call(ann, 'GET', `/workspaces/${owner.workspaceId}/calendar-feed`);
    expect(status.body.url).toBeUndefined();
    expect(status.body.hint).toBe(made.body.url.slice(-8, -4));
  });

  it('follows overrides', async () => {
    const { body: made } = await api.call(ben, 'POST', `/workspaces/${owner.workspaceId}/calendar-feed`);
    const before = (await read(made.url)).body.match(/BEGIN:VEVENT/g)!.length;
    // One of Ann's days, ten or eleven days out, for Ben to cover.
    let start = new Date(Date.now() + 10 * 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const probe = (t: Date) =>
      api.call(owner, 'GET', `/schedules/${scheduleId}/shifts?from=${encodeURIComponent(t.toISOString())}&to=${encodeURIComponent(new Date(t.getTime() + 1000).toISOString())}`);
    if ((await probe(start)).body.shifts[0].userId !== ann.id) start = new Date(start.getTime() + 86_400_000);
    await api.call(owner, 'POST', `/schedules/${scheduleId}/overrides`, {
      userId: ben.id,
      replacedUserId: ann.id,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 86_400_000).toISOString(),
    });
    const after = (await read(made.url)).body;
    expect(after).toContain('covering for');
    expect(after.match(/BEGIN:VEVENT/g)!.length).toBe(before + 1);
  });

  it('stops the old address when reset', async () => {
    const { body: first } = await api.call(ann, 'POST', `/workspaces/${owner.workspaceId}/calendar-feed`);
    const { body: second } = await api.call(ann, 'POST', `/workspaces/${owner.workspaceId}/calendar-feed`);
    expect((await read(first.url)).status).toBe(404);
    expect((await read(second.url)).status).toBe(200);
  });

  it('respects access and the app being off', async () => {
    const { body: mine } = await api.call(ann, 'POST', `/workspaces/${owner.workspaceId}/calendar-feed?scheduleId=${scheduleId}`);
    expect((await read(mine.url)).body).toContain('SUMMARY:Ben');

    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'deny', entries: [{ userId: ann.id, permission: 'none' }] });
    expect((await read(mine.url)).status).toBe(404);
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'open' });
    expect((await read(mine.url)).status).toBe(200);

    await api.sql(`UPDATE workspaces SET disabled_apps = '{schedules}' WHERE id = $1`, [owner.workspaceId]);
    expect((await read(mine.url)).status).toBe(404);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [owner.workspaceId]);
  });
});
