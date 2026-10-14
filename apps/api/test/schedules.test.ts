import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

describe('schedules', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let ws: string;

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Edie');
    viewer = await api.register('Vic');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
  });

  afterAll(() => api.close());

  const create = (user: TestUser, body: object) =>
    api.call(user, 'POST', `/workspaces/${ws}/schedules`, { timeZone: 'Europe/London', ...body });

  it('starts with approval off, and needs schedules.create', async () => {
    const made = await create(editor, { name: 'Platform on-call', members: [{ userId: viewer.id }] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ requiresApproval: false, memberCount: 1, can: { edit: true, override: false } });

    expect((await create(viewer, { name: 'Nope' })).status).toBe(403);
    expect((await create(editor, { name: 'Bad zone', timeZone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('refuses everything while Schedules is off', async () => {
    await api.sql(`UPDATE workspaces SET disabled_apps = '{schedules}' WHERE id = $1`, [ws]);
    expect((await api.call(owner, 'GET', `/workspaces/${ws}/schedules`)).status).toBe(403);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [ws]);
    expect((await api.call(owner, 'GET', `/workspaces/${ws}/schedules`)).status).toBe(200);
  });

  it('hides a locked schedule from the list and by id', async () => {
    const { body: locked } = await create(owner, { name: 'Leads only' });
    const lock = await api.call(owner, 'PUT', `/schedules/${locked.id}/access`, {
      access: 'allow',
      entries: [{ userId: editor.id, permission: 'edit' }],
    });
    expect(lock.status).toBe(200);

    const names = async (user: TestUser) =>
      (await api.call(user, 'GET', `/workspaces/${ws}/schedules`)).body.map((s: { name: string }) => s.name);
    expect(await names(editor)).toContain('Leads only');
    expect(await names(viewer)).not.toContain('Leads only');
    expect((await api.call(viewer, 'GET', `/schedules/${locked.id}`)).status).toBe(404);
  });

  it('lets "Can override" on one schedule reach only that schedule', async () => {
    const { body: one } = await create(owner, { name: 'One' });
    const { body: two } = await create(owner, { name: 'Two' });
    const granted = await api.call(owner, 'PUT', `/schedules/${one.id}/override-grants`, {
      entries: [{ userId: viewer.id }],
    });
    expect(granted.status).toBe(200);
    expect(granted.body.overrideGrants).toEqual([{ kind: 'user', id: viewer.id, name: 'Vic' }]);

    expect((await api.call(viewer, 'GET', `/schedules/${one.id}`)).body.can.override).toBe(true);
    expect((await api.call(viewer, 'GET', `/schedules/${two.id}`)).body.can.override).toBe(false);
    // Nor can they hand it out themselves.
    expect((await api.call(viewer, 'PUT', `/schedules/${two.id}/override-grants`, { entries: [] })).status).toBe(403);
  });

  it('lets a manager run a schedule their role could not', async () => {
    const { body: s } = await create(owner, { name: 'Managed', members: [{ userId: viewer.id, manager: true }] });
    const seen = await api.call(viewer, 'GET', `/schedules/${s.id}`);
    expect(seen.body.can).toMatchObject({ edit: true, override: true, approve: true, request: true, grantOverride: true });
    expect((await api.call(viewer, 'PATCH', `/schedules/${s.id}`, { requiresApproval: true })).body.requiresApproval).toBe(true);
    expect(seen.body.can.delete).toBe(false);
  });

  it('deletes a schedule with everything on it', async () => {
    const { body: s } = await create(editor, { name: 'Short-lived', members: [{ userId: viewer.id }] });
    await api.sql(
      `INSERT INTO schedule_layers (schedule_id, lineage_id, kind, name, config, effective_from)
       VALUES ($1, gen_random_uuid(), 'rotation', 'L', '{}', now())`,
      [s.id],
    );
    // Someone else's needs schedules.delete; the one who started it may.
    expect((await api.call(viewer, 'DELETE', `/schedules/${s.id}`)).status).toBe(403);
    expect((await api.call(editor, 'DELETE', `/schedules/${s.id}`)).status).toBe(204);
    const left = await api.sql('SELECT 1 FROM schedule_layers WHERE schedule_id = $1', [s.id]);
    expect(left).toHaveLength(0);
  });

  it('replaces the member list, refusing people outside the workspace', async () => {
    const outsider = await api.register('Outsider');
    const { body: s } = await create(owner, { name: 'Members' });
    const bad = await api.call(owner, 'PUT', `/schedules/${s.id}/members`, { members: [{ userId: outsider.id }] });
    expect(bad.status).toBe(400);
    const good = await api.call(owner, 'PUT', `/schedules/${s.id}/members`, {
      members: [{ userId: editor.id, manager: true }, { userId: viewer.id }],
    });
    expect(good.body.members.map((m: { name: string; manager: boolean }) => [m.name, m.manager])).toEqual([
      ['Edie', true],
      ['Vic', false],
    ]);
  });
});
