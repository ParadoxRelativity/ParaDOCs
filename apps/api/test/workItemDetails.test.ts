import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/** Work items in detail, as a status slide shows them. */
describe('work item details', () => {
  let api: Api;
  let owner: TestUser;
  let outsider: TestUser;
  let project: { id: string; statuses: { id: string; name: string; category: string }[]; itemTypes: { id: string; epic: boolean }[]; roles: { id: string; name: string }[] };
  let epicId: string;
  let doneStatus: string;

  async function item(body: Record<string, unknown>) {
    const made = await api.call(owner, 'POST', `/projects/${project.id}/items`, body);
    expect(made.status).toBe(201);
    return made.body.id as string;
  }

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    outsider = await api.register('Outsider');
    const made = await api.call(owner, 'POST', `/workspaces/${owner.workspaceId}/projects`, { name: 'Launch', key: 'LCH' });
    expect(made.status).toBe(201);
    project = (await api.call(owner, 'GET', `/projects/${made.body.id}`)).body;
    doneStatus = project.statuses.find((s) => s.category === 'done')!.id;
    const epicType = project.itemTypes.find((t) => t.epic)!.id;
    const firstRole = project.roles[0].id;
    epicId = await item({ title: 'Ship it', typeId: epicType, dueDate: '2026-11-30', roles: { [firstRole]: [owner.id] } });
    await item({ title: 'Write the docs', epicId, statusId: doneStatus, estimate: 2 });
    await item({ title: 'Build it', epicId, estimate: 3 });
    await item({ title: 'Test it', epicId });
  });

  afterAll(async () => {
    await api.close();
  });

  it('reports who is on an epic, when it is due and how far the work under it has got', async () => {
    const { status, body } = await api.call(owner, 'POST', '/work-item-refs/details', { ids: [epicId] });
    expect(status).toBe(200);
    const [epic] = body.items;
    expect(epic).toMatchObject({ id: epicId, title: 'Ship it', epic: true, dueDate: '2026-11-30', people: ['Owner'] });
    expect(epic.progress).toEqual({ total: 3, done: 1, estimate: 5, doneEstimate: 2 });
    expect(epic.children.map((c: { title: string }) => c.title)).toHaveLength(3);
    // Open work comes first, done work last.
    expect(epic.children.at(-1).title).toBe('Write the docs');
    expect(epic.statuses.reduce((n: number, s: { count: number }) => n + s.count, 0)).toBe(3);
  });

  it('counts archived work under an epic as done', async () => {
    const archived = await item({ title: 'Old work', epicId });
    await api.sql('UPDATE work_items SET archived_at = now() WHERE id = $1', [archived]);
    const { body } = await api.call(owner, 'POST', '/work-item-refs/details', { ids: [epicId] });
    expect(body.items[0].progress).toMatchObject({ total: 4, done: 2 });
    expect(body.items[0].children.map((c: { title: string }) => c.title)).not.toContain('Old work');
  });

  it('gives an item with nothing under it no progress', async () => {
    const lone = await item({ title: 'Alone' });
    const { body } = await api.call(owner, 'POST', '/work-item-refs/details', { ids: [lone] });
    expect(body.items[0]).toMatchObject({ progress: null, children: [], statuses: [], people: [] });
  });

  it('tells someone who may not see the project nothing about it', async () => {
    const { status, body } = await api.call(outsider, 'POST', '/work-item-refs/details', { ids: [epicId] });
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });
});
