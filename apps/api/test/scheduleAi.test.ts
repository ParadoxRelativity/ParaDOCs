import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * The AI tools, search and links for schedules. The tools are run as the MCP
 * server runs them: through the app's own routes, as the connected person.
 */
describe('schedules for AI, search and links', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let stranger: TestUser;
  let scheduleId: string;
  let run: (user: TestUser, name: string, args: object) => Promise<string>;

  beforeAll(async () => {
    api = await startApi();
    const { runTool } = await import('../src/mcp/tools.js');
    run = (user, name, args) =>
      runTool(
        {
          app: api.app,
          authorization: `Bearer ${user.token}`,
          userId: user.id,
          ai: { connectionId: 'test', workspaceId: null, canWrite: true },
          origin: 'https://docs.example.com',
        },
        name,
        args,
      );

    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    stranger = await api.register('Stan');
    for (const user of [ann, ben, stranger]) await api.join(user, owner.workspaceId, 'Editor');
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, {
      name: 'Platform',
      description: 'Primary on-call for the platform team',
      timeZone: 'UTC',
    });
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

  /** Whose day it is, in this daily rotation of Ann then Ben from 1 January 2026. */
  const onDay = (date: Date) => (Math.floor((date.getTime() - Date.parse('2026-01-01T00:00:00Z')) / 86_400_000) % 2 === 0 ? ann : ben);

  it('answers who is on call right now', async () => {
    const answer = await run(owner, 'who_is_on', { schedule: 'platform' });
    expect(answer).toContain(`- ${onDay(new Date()).name}, until`);
    expect(answer).toContain(`/sc/${scheduleId}`);
  });

  it('lists schedules and my shifts', async () => {
    expect(await run(ann, 'list_schedules', {})).toMatch(/Platform .*you are on it/);
    const mine = await run(ann, 'my_shifts', {});
    expect(mine).toMatch(/Platform:/);
  });

  it('requests a replacement as the UI does, only asking people on the schedule', async () => {
    // Ann's next whole day, starting tomorrow or the day after.
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 1);
    if (onDay(day) !== ann) day.setUTCDate(day.getUTCDate() + 1);
    const start = day.toISOString().slice(0, 16);
    const end = new Date(day.getTime() + 86_400_000).toISOString().slice(0, 16);

    await expect(run(ann, 'request_replacement', { schedule: 'Platform', start, end, people: 'Stan' })).rejects.toThrow(/not on Platform/);
    const done = await run(ann, 'request_replacement', { schedule: 'Platform', start, end, people: 'Ben', note: 'Dentist' });
    expect(done).toContain('Asked Ben to cover');
    const requests = await api.call(owner, 'GET', `/schedules/${scheduleId}/requests`);
    expect(requests.body[0]).toMatchObject({ requesterName: 'Ann', note: 'Dentist', candidates: [{ name: 'Ben' }] });
    // Ben hears of it, as from the UI.
    const bell = await api.call(ben, 'GET', '/notifications');
    expect(bell.body.schedules[0]).toMatchObject({ reason: 'request' });
  });

  it('finds schedules in search, only where they can be seen', async () => {
    const found = await api.call(ann, 'GET', `/workspaces/${owner.workspaceId}/search?q=platform`);
    expect(found.body.schedules.map((s: { name: string }) => s.name)).toEqual(['Platform']);
    expect(await run(ann, 'search', { query: 'on-call' })).toContain('schedule "Platform"');

    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'deny', entries: [{ userId: stranger.id, permission: 'none' }] });
    const hidden = await api.call(stranger, 'GET', `/workspaces/${owner.workspaceId}/search?q=platform`);
    expect(hidden.body.schedules).toEqual([]);
  });

  it('resolves links in chat, and stops when access goes', async () => {
    const { resolveReferences } = await import('../src/lib/chatReferences.js');
    const body = `See <sched:${scheduleId}>`;
    expect((await resolveReferences([body], owner.workspaceId, ann.id)).schedules).toEqual([
      { id: scheduleId, name: 'Platform', color: expect.any(String) },
    ]);
    expect((await resolveReferences([body], owner.workspaceId, stranger.id)).schedules).toEqual([]);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{schedules}' WHERE id = $1`, [owner.workspaceId]);
    expect((await resolveReferences([body], owner.workspaceId, ann.id)).schedules).toEqual([]);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [owner.workspaceId]);
  });
});
