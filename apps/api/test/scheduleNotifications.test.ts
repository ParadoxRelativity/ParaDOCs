import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('schedule notifications', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let scheduleId: string;
  const emails: { to: string; subject: string; text: string; link: string }[] = [];
  let sweep: (now?: Date) => Promise<void>;

  beforeAll(async () => {
    api = await startApi();
    // Imported once the API is up: the modules read their settings when loaded.
    const delivery = await import('../src/lib/scheduleDelivery.js');
    delivery.setEmailTransport(async (message) => {
      emails.push(message);
    });
    ({ sweepScheduleNotices: sweep } = await import('../src/lib/scheduleNotifications.js'));

    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    for (const user of [ann, ben]) await api.join(user, owner.workspaceId, 'Editor');
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name: 'On call', timeZone: 'UTC' });
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

  const bell = async (user: TestUser) => (await api.call(user, 'GET', '/notifications')).body.schedules ?? [];
  const clear = async () => {
    emails.length = 0;
    await api.sql('DELETE FROM schedule_notifications');
  };

  it('tells the covered and covering people about an override, but not the one who made it', async () => {
    await clear();
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const from = start.toISOString();
    const shifts = await api.call(owner, 'GET', `/schedules/${scheduleId}/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(start.getTime() + 3_600_000).toISOString())}`);
    const covered = shifts.body.shifts[0].userId;
    const covering = covered === ann.id ? ben : ann;
    await api.call(owner, 'POST', `/schedules/${scheduleId}/overrides`, {
      userId: covering.id,
      replacedUserId: covered,
      startsAt: from,
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    });

    expect((await bell(covering))[0]).toMatchObject({ reason: 'override', scheduleName: 'On call', by: { name: 'Owner' } });
    expect(await bell(covering === ann ? ben : ann)).toHaveLength(1);
    expect(await bell(owner)).toHaveLength(0);

    // The email channel built a message for each of them, and sent none: the transport here only records.
    const addresses = await api.sql<{ email: string }>('SELECT email FROM users WHERE id = ANY($1::uuid[])', [[ann.id, ben.id]]);
    expect(emails.map((e) => e.to).sort()).toEqual(addresses.map((a) => a.email).sort());
    expect(emails[0].subject).toMatch(/Owner changed your shift on On call/);
    expect(emails[0].link).toContain(`/sc/${scheduleId}`);
    const sent = await api.sql<{ in_app_sent_at: string | null; email_sent_at: string | null }>(
      'SELECT in_app_sent_at, email_sent_at FROM schedule_notifications',
    );
    expect(sent.every((n) => n.in_app_sent_at && n.email_sent_at)).toBe(true);
  });

  it('tells the people asked about a request', async () => {
    await clear();
    const start = new Date(Date.now() + 5 * 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const shifts = await api.call(owner, 'GET', `/schedules/${scheduleId}/shifts?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(start.getTime() + 1000).toISOString())}`);
    const mine = shifts.body.shifts[0];
    const requester = mine.userId === ann.id ? ann : ben;
    const other = requester === ann ? ben : ann;
    await api.call(requester, 'POST', `/schedules/${scheduleId}/requests`, { kind: 'cover', startsAt: mine.start, endsAt: mine.end });
    expect((await bell(other))[0]).toMatchObject({ reason: 'request' });
    expect(await bell(requester)).toHaveLength(0);
  });

  it('reminds once before a shift, however often it sweeps', async () => {
    await clear();
    // Half an hour before tomorrow's handoff.
    const handoff = new Date();
    handoff.setUTCDate(handoff.getUTCDate() + 1);
    handoff.setUTCHours(0, 0, 0, 0);
    const now = new Date(handoff.getTime() - 30 * 60_000);
    await sweep(now);
    await sweep(now);
    const reminders = await api.sql<{ user_id: string }>(`SELECT user_id FROM schedule_notifications WHERE reason = 'reminder'`);
    expect(reminders).toHaveLength(1);

    // At the handoff itself, "you are on call".
    await sweep(new Date(handoff.getTime() + 60_000));
    const onCall = await api.sql(`SELECT 1 FROM schedule_notifications WHERE reason = 'on_call'`);
    expect(onCall).toHaveLength(1);
  });

  it('respects a reminder setting of never', async () => {
    await clear();
    for (const user of [ann, ben]) {
      expect((await api.call(user, 'PUT', '/schedule-settings', { reminderMinutes: 0 })).status).toBe(200);
    }
    const handoff = new Date();
    handoff.setUTCDate(handoff.getUTCDate() + 2);
    handoff.setUTCHours(0, 0, 0, 0);
    await sweep(new Date(handoff.getTime() - 30 * 60_000));
    expect(await api.sql(`SELECT 1 FROM schedule_notifications WHERE reason = 'reminder'`)).toHaveLength(0);
    for (const user of [ann, ben]) await api.call(user, 'PUT', '/schedule-settings', { reminderMinutes: 60 });
  });

  it('stops reminders, and hides notifications, when Schedules is turned off', async () => {
    await clear();
    await api.sql(`UPDATE workspaces SET disabled_apps = '{schedules}' WHERE id = $1`, [owner.workspaceId]);
    const handoff = new Date();
    handoff.setUTCDate(handoff.getUTCDate() + 3);
    handoff.setUTCHours(0, 0, 0, 0);
    await sweep(new Date(handoff.getTime() - 30 * 60_000));
    expect(await api.sql(`SELECT 1 FROM schedule_notifications`)).toHaveLength(0);

    await api.sql(
      `INSERT INTO schedule_notifications (user_id, schedule_id, reason) VALUES ($1, $2, 'reminder')`,
      [ann.id, scheduleId],
    );
    expect(await bell(ann)).toHaveLength(0);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [owner.workspaceId]);
    expect(await bell(ann)).toHaveLength(1);
  });

  it('stops showing notifications for a schedule someone lost access to', async () => {
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'deny', entries: [{ userId: ann.id, permission: 'none' }] });
    expect(await bell(ann)).toHaveLength(0);
    await api.call(owner, 'PUT', `/schedules/${scheduleId}/access`, { access: 'open' });
  });
});
