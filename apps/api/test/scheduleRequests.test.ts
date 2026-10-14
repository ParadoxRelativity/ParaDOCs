import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * A daily rotation of Ann, Ben and Cat handing off at 00:00 UTC, so whose day
 * any date is can be worked out here.
 */
describe('replacement requests', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let cat: TestUser;
  let stranger: TestUser;
  let scheduleId: string;
  const ANCHOR = Date.parse('2026-01-01T00:00:00Z');
  const DAY = 86_400_000;

  /** The start of the next day, at least `ahead` days out, that is `user`'s. */
  const dayOf = (user: TestUser, ahead = 2) => {
    const order = [ann, ben, cat];
    let start = Math.ceil((Date.now() + ahead * DAY - ANCHOR) / DAY);
    while (order[start % 3].id !== user.id) start += 1;
    const from = new Date(ANCHOR + start * DAY);
    return { startsAt: from.toISOString(), endsAt: new Date(from.getTime() + DAY).toISOString() };
  };

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    cat = await api.register('Cat');
    stranger = await api.register('Stan');
    for (const user of [ann, ben, cat, stranger]) await api.join(user, owner.workspaceId, 'Editor');
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name: 'On call', timeZone: 'UTC' });
    scheduleId = body.id;
    await api.call(owner, 'POST', `/schedules/${scheduleId}/layers`, {
      kind: 'rotation',
      name: 'Primary',
      config: { start: '2026-01-01T00:00', length: { unit: 'days', count: 1 } },
      members: [ann, ben, cat].map((u) => ({ userId: u.id })),
    });
    await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [scheduleId]);
  });

  afterAll(() => api.close());

  const ask = (user: TestUser, body: object) => api.call(user, 'POST', `/schedules/${scheduleId}/requests`, { kind: 'cover', ...body });

  it('asks for cover on one of my shifts', async () => {
    const made = await ask(ann, { ...dayOf(ann), note: 'Wedding' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ status: 'open', askEveryone: true, requesterName: 'Ann', note: 'Wedding' });

    const forBen = await api.call(ben, 'GET', `/workspaces/${owner.workspaceId}/my-requests`);
    expect(forBen.body.find((r: { id: string }) => r.id === made.body.id)?.canAccept).toBe(true);
  });

  it('refuses a shift that is not mine, or has started', async () => {
    expect((await ask(ann, dayOf(ben))).status).toBe(400);
    const now = Date.now();
    expect((await ask(ann, { startsAt: new Date(now - DAY).toISOString(), endsAt: new Date(now).toISOString() })).status).toBe(400);
  });

  it('refuses two open requests for the same time', async () => {
    const window = dayOf(ann, 6);
    expect((await ask(ann, window)).status).toBe(201);
    expect((await ask(ann, window)).status).toBe(409);
  });

  it('only asks people on the schedule, and only lets them ask', async () => {
    const refused = await ask(ben, { ...dayOf(ben), askUserIds: [stranger.id] });
    expect(refused.status).toBe(403);
    // Stan can see the schedule but is not on it.
    expect((await ask(stranger, dayOf(ann))).status).toBe(403);

    const specific = await ask(ben, { ...dayOf(ben), askUserIds: [cat.id] });
    expect(specific.status).toBe(201);
    expect(specific.body.candidates).toEqual([{ userId: cat.id, name: 'Cat' }]);
    const forAnn = await api.call(ann, 'GET', `/workspaces/${owner.workspaceId}/my-requests`);
    expect(forAnn.body.some((r: { id: string }) => r.id === specific.body.id)).toBe(false);
  });

  it('lets me cancel my own open request, and nobody else', async () => {
    const made = await ask(cat, dayOf(cat));
    expect((await api.call(ann, 'POST', `/schedules/${scheduleId}/requests/${made.body.id}/cancel`)).status).toBe(403);
    const cancelled = await api.call(cat, 'POST', `/schedules/${scheduleId}/requests/${made.body.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    // And a cancelled window is free to ask about again.
    expect((await ask(cat, dayOf(cat))).status).toBe(201);
  });

  it('expires requests nobody answered once the shift starts', async () => {
    const made = await ask(ben, dayOf(ben, 9));
    await api.sql(`UPDATE schedule_requests SET starts_at = now() - interval '1 minute' WHERE id = $1`, [made.body.id]);
    const { body } = await api.call(owner, 'GET', `/schedules/${scheduleId}/requests?all=true`);
    expect(body.find((r: { id: string }) => r.id === made.body.id).status).toBe('expired');
  });
});
