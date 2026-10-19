import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * A queue's response time: work nobody responds to is escalated to Cara on the
 * backup schedule after 15 minutes, then to Dan, the manager, half an hour
 * after that. Off, the queue works as it always has.
 */
describe('queue response time', () => {
  let api: Api;
  let owner: TestUser;
  let ann: TestUser;
  let cara: TestUser;
  let dan: TestUser;
  let queueId: string;
  let assigneeId: string;
  let escalationId: string;
  let managerId: string;
  let sweep: (now?: Date) => Promise<number>;

  const minutes = (n: number) => new Date(Date.now() + n * 60_000);

  async function schedule(name: string, person: TestUser): Promise<string> {
    const { body } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/schedules`, { name, timeZone: 'UTC' });
    await api.call(owner, 'POST', `/schedules/${body.id}/layers`, {
      kind: 'rotation',
      name: 'Rotation',
      config: { start: '2026-01-01T00:00', length: { unit: 'days', count: 1 } },
      members: [{ userId: person.id }],
    });
    await api.sql(`UPDATE schedule_layers SET effective_from = '2026-01-01T00:00:00Z' WHERE schedule_id = $1`, [body.id]);
    return body.id;
  }

  const file = async (title: string) =>
    (await api.call(owner, 'POST', `/projects/${queueId}/items`, { title, roles: { [assigneeId]: [ann.id] } })).body;
  const escalations = async (itemId: string) =>
    (await api.call(owner, 'GET', `/work-items/${itemId}/timeline`)).body.activity.filter(
      (a: { kind: string }) => a.kind === 'escalated',
    );
  const bellFor = async (user: TestUser, itemId: string) =>
    ((await api.call(user, 'GET', '/notifications')).body.workItems ?? []).find(
      (n: { workItemId: string }) => n.workItemId === itemId,
    );
  const turnOn = () =>
    api.call(owner, 'PATCH', `/projects/${queueId}`, {
      responseTime: {
        roleId: assigneeId,
        steps: [
          { roleId: escalationId, afterMinutes: 15 },
          { roleId: managerId, afterMinutes: 30 },
        ],
      },
    });

  beforeAll(async () => {
    api = await startApi();
    ({ sweepEscalations: sweep } = await import('../src/lib/escalations.js'));
    owner = await api.register('Owner');
    ann = await api.register('Ann');
    cara = await api.register('Cara');
    dan = await api.register('Dan');
    for (const user of [ann, cara, dan]) await api.join(user, owner.workspaceId, 'Editor');

    const { body: queue } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/projects`, {
      name: 'Support',
      key: 'SUP',
      kind: 'queue',
    });
    queueId = queue.id;
    assigneeId = queue.roles.find((r: { name: string }) => r.name === 'Assignee').id;
    escalationId = (
      await api.call(owner, 'POST', `/projects/${queueId}/roles`, { name: 'Escalation', scheduleId: await schedule('Backup', cara) })
    ).body.id;
    managerId = (
      await api.call(owner, 'POST', `/projects/${queueId}/roles`, { name: 'Manager', scheduleId: await schedule('Managers', dan) })
    ).body.id;
  });

  afterAll(() => api.close());

  it('is off unless a queue turns it on, and the queue works as before', async () => {
    const { body: queue } = await api.call(owner, 'GET', `/projects/${queueId}`);
    expect(queue.responseTime).toBeNull();
    const item = await file('Before');
    // Filled from its schedule when filed, as without a response time.
    expect(item.roles[escalationId]).toEqual([cara.id]);
    expect(await sweep(minutes(600))).toBe(0);
    expect(await escalations(item.id)).toEqual([]);
  });

  it('is only for queues, and each step takes a role of its own', async () => {
    const { body: project } = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/projects`, {
      name: 'Roadmap',
      key: 'MAP',
    });
    const refused = await api.call(owner, 'PATCH', `/projects/${project.id}`, {
      responseTime: { roleId: null, steps: [{ roleId: project.roles[0].id, afterMinutes: 5 }] },
    });
    expect(refused.status).toBe(400);
    const twice = await api.call(owner, 'PATCH', `/projects/${queueId}`, {
      responseTime: {
        roleId: assigneeId,
        steps: [
          { roleId: escalationId, afterMinutes: 5 },
          { roleId: escalationId, afterMinutes: 5 },
        ],
      },
    });
    expect(twice.status).toBe(400);
    const toItself = await api.call(owner, 'PATCH', `/projects/${queueId}`, {
      responseTime: { roleId: assigneeId, steps: [{ roleId: assigneeId, afterMinutes: 5 }] },
    });
    expect(toItself.status).toBe(400);
  });

  it('escalates work nobody responded to, step by step, once each', async () => {
    const { status, body: queue } = await turnOn();
    expect(status).toBe(200);
    expect(queue.responseTime.steps).toEqual([
      { roleId: escalationId, afterMinutes: 15 },
      { roleId: managerId, afterMinutes: 30 },
    ]);

    const item = await file('Printer on fire');
    // The roles it escalates to wait until it does.
    expect(item.roles[escalationId] ?? []).toEqual([]);
    expect(await sweep(minutes(10))).toBe(0);

    expect(await sweep(minutes(16))).toBe(1);
    const { body: after } = await api.call(owner, 'GET', `/work-items/${item.id}`);
    expect(after.roles[escalationId]).toEqual([cara.id]);
    expect(after.roles[assigneeId]).toEqual([ann.id]);
    const [first] = await escalations(item.id);
    expect(first).toMatchObject({ role: 'Escalation', added: [cara.id], minutes: 15, actor: null });
    expect(await bellFor(cara, item.id)).toMatchObject({ reason: 'escalated' });
    expect((await bellFor(ann, item.id)).escalation).toBe('Escalated to Cara (Escalation) after 15 minutes without a response');

    expect(await sweep(minutes(16))).toBe(0);
    expect(await sweep(minutes(46))).toBe(1);
    expect((await api.call(owner, 'GET', `/work-items/${item.id}`)).body.roles[managerId]).toEqual([dan.id]);
    expect((await bellFor(cara, item.id)).escalation).toBe('Escalated to Dan (Manager) after 45 minutes without a response');
    expect(await sweep(minutes(600))).toBe(0);
    expect(await escalations(item.id)).toHaveLength(2);
  });

  it('stops when someone responds', async () => {
    const commented = await file('Answered');
    await api.call(ann, 'POST', `/work-items/${commented.id}/comments`, { body: 'Looking now' });
    const { body: queue } = await api.call(owner, 'GET', `/projects/${queueId}`);
    const moved = await file('Picked up');
    const active = queue.statuses.find((s: { category: string }) => s.category === 'active');
    await api.call(ann, 'PATCH', `/work-items/${moved.id}`, { statusId: active.id });
    expect(await sweep(minutes(600))).toBe(0);
    expect(await escalations(commented.id)).toEqual([]);
    expect(await escalations(moved.id)).toEqual([]);
  });

  it('does not count a comment from whoever filed it', async () => {
    const item = await file('Just me');
    await api.call(owner, 'POST', `/work-items/${item.id}/comments`, { body: 'Any update?' });
    expect(await sweep(minutes(16))).toBe(1);
  });

  it('leaves archived work alone', async () => {
    const item = await file('Put away');
    await api.sql('UPDATE work_items SET archived_at = now() WHERE id = $1', [item.id]);
    await sweep(minutes(600));
    expect(await escalations(item.id)).toEqual([]);
  });

  it('waits for intake work too, and escalates it', async () => {
    await api.sql(`INSERT INTO server_settings (key, value) VALUES ('intakeWebhooks', 'true'::jsonb)`);
    const { body: token } = await api.call(owner, 'POST', `/projects/${queueId}/intake-tokens`, { name: 'Website' });
    const response = await api.app.inject({
      method: 'POST',
      url: '/api/intake',
      headers: { authorization: `Bearer ${token.token}` },
      payload: { title: 'From the website', requester: 'Pat' },
    });
    const { id } = JSON.parse(response.body);
    expect((await api.call(owner, 'GET', `/work-items/${id}`)).body.roles[escalationId] ?? []).toEqual([]);
    expect(await sweep(minutes(16))).toBe(1);
    expect((await api.call(owner, 'GET', `/work-items/${id}`)).body.roles[escalationId]).toEqual([cara.id]);
  });

  it('turns off, and turned on again, leaves earlier work alone', async () => {
    const waiting = await file('Waiting');
    const { body: off } = await api.call(owner, 'PATCH', `/projects/${queueId}`, { responseTime: null });
    expect(off.responseTime).toBeNull();
    expect(await sweep(minutes(600))).toBe(0);
    await turnOn();
    expect(await sweep(minutes(600))).toBe(0);
    expect(await escalations(waiting.id)).toEqual([]);
  });

  it('turns off when the roles it escalates to are deleted', async () => {
    await api.call(owner, 'DELETE', `/project-roles/${escalationId}`);
    expect((await api.call(owner, 'GET', `/projects/${queueId}`)).body.responseTime.steps).toEqual([
      { roleId: managerId, afterMinutes: 30 },
    ]);
    await api.call(owner, 'DELETE', `/project-roles/${managerId}`);
    expect((await api.call(owner, 'GET', `/projects/${queueId}`)).body.responseTime).toBeNull();
  });
});
