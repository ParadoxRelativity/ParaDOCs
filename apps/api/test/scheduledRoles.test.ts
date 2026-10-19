import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * A queue's roles filled from schedules: whoever is on call when work comes
 * in, in the app or through an intake form, with an escalation role beside
 * the assignee following its own rotation.
 */
describe('roles filled from a schedule', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let ben: TestUser;
  let cara: TestUser;
  let queueId: string;
  let assigneeId: string;
  let escalationId: string;
  let primaryId: string;
  let backupId: string;

  async function schedule(name: string, people: TestUser[]): Promise<string> {
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name, timeZone: 'UTC' });
    if (people.length > 0) {
      await api.call(owner, 'POST', `/schedules/${body.id}/layers`, {
        kind: 'rotation',
        name: 'Rotation',
        config: { start: '2026-01-01T00:00', length: { unit: 'days', count: 1 } },
        members: people.map((u) => ({ userId: u.id })),
      });
      await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [body.id]);
    }
    return body.id;
  }

  /** Whose day it is, in the daily rotation of Ann then Ben from 1 January 2026. */
  const onDay = (date: Date) => (Math.floor((date.getTime() - Date.parse('2026-01-01T00:00:00Z')) / 86_400_000) % 2 === 0 ? ann : ben);

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    ann = await api.register('Ann');
    ben = await api.register('Ben');
    cara = await api.register('Cara');
    for (const user of [ann, ben, cara]) await api.join(user, owner.workspaceId, 'Editor');
    primaryId = await schedule('Primary', [ann, ben]);
    backupId = await schedule('Backup', [cara]);

    const { body: queue } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/projects`, {
      name: 'Support',
      key: 'SUP',
      kind: 'queue',
    });
    queueId = queue.id;
    assigneeId = queue.roles.find((r: { name: string }) => r.name === 'Assignee').id;
    const changed = await api.call(owner, 'PATCH', `/project-roles/${assigneeId}`, { scheduleId: primaryId });
    expect(changed.body.scheduleId).toBe(primaryId);
    const escalation = await api.call(owner, 'POST', `/projects/${queueId}/roles`, { name: 'Escalation', scheduleId: backupId });
    expect(escalation.status).toBe(201);
    escalationId = escalation.body.id;
  });

  afterAll(() => api.close());

  it('fills each role with whoever is on its schedule', async () => {
    const { status, body } = await api.call(owner, 'POST', `/projects/${queueId}/items`, { title: 'Printer on fire' });
    expect(status).toBe(201);
    expect(body.roles[assigneeId]).toEqual([onDay(new Date()).id]);
    expect(body.roles[escalationId]).toEqual([cara.id]);
    // The person on call hears of it.
    const bell = await api.call(cara, 'GET', '/notifications');
    expect(JSON.stringify(bell.body)).toContain(body.id);
  });

  it('keeps who the creator named, nobody included', async () => {
    const { body } = await api.call(owner, 'POST', `/projects/${queueId}/items`, {
      title: 'Named',
      roles: { [assigneeId]: [owner.id], [escalationId]: [] },
    });
    expect(body.roles[assigneeId]).toEqual([owner.id]);
    expect(body.roles[escalationId] ?? []).toEqual([]);
  });

  it('falls back to the creator when nobody is on and the role takes them', async () => {
    const empty = await schedule('Nobody', []);
    await api.call(owner, 'PATCH', `/project-roles/${escalationId}`, { scheduleId: empty, fillWithCreator: true });
    const { body } = await api.call(ann, 'POST', `/projects/${queueId}/items`, { title: 'Quiet night' });
    expect(body.roles[escalationId]).toEqual([ann.id]);
    await api.call(owner, 'PATCH', `/project-roles/${escalationId}`, { scheduleId: backupId, fillWithCreator: false });
  });

  it('fills them for work sent in through an intake form', async () => {
    await api.sql(`INSERT INTO server_settings (key, value) VALUES ('intakeWebhooks', 'true'::jsonb)`);
    const { body: token } = await api.call(owner, 'POST', `/projects/${queueId}/intake-tokens`, { name: 'Website' });
    const response = await api.app.inject({
      method: 'POST',
      url: '/api/intake',
      headers: { authorization: `Bearer ${token.token}` },
      payload: { title: 'From the website', requester: 'Pat' },
    });
    expect(response.statusCode).toBe(201);
    const { id } = JSON.parse(response.body);
    const { body } = await api.call(owner, 'GET', `/work-items/${id}`);
    expect(body.roles[assigneeId]).toEqual([onDay(new Date()).id]);
    expect(body.roles[escalationId]).toEqual([cara.id]);
    const bell = await api.call(cara, 'GET', '/notifications');
    expect(JSON.stringify(bell.body)).toContain(id);
  });

  it('only takes a schedule in the workspace', async () => {
    const outsider = await api.register('Olga');
    const { body: theirs } = await api.call(outsider, 'POST', `/workspaces/${outsider.workspaceId}/schedules`, {
      name: 'Elsewhere',
      timeZone: 'UTC',
    });
    const refused = await api.call(owner, 'PATCH', `/project-roles/${assigneeId}`, { scheduleId: theirs.id });
    expect(refused.status).toBe(400);
  });

  it('becomes an ordinary role when its schedule is deleted', async () => {
    await api.call(owner, 'DELETE', `/schedules/${backupId}`);
    const { body: queue } = await api.call(owner, 'GET', `/projects/${queueId}`);
    expect(queue.roles.find((r: { id: string }) => r.id === escalationId).scheduleId).toBeNull();
    const { body } = await api.call(owner, 'POST', `/projects/${queueId}/items`, { title: 'After' });
    expect(body.roles[escalationId] ?? []).toEqual([]);
  });

  it('can be taken off again', async () => {
    const { body } = await api.call(owner, 'PATCH', `/project-roles/${assigneeId}`, { scheduleId: null });
    expect(body.scheduleId).toBeNull();
  });
});
