import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/** The Slides app over HTTP: listing, filing, locking, archiving, duplicating and deleting presentations. */
describe('presentation routes', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;

  const create = (user: TestUser, body: Record<string, unknown> = {}) =>
    api.call(user, 'POST', `/workspaces/${ws}/presentations`, body);
  const titles = async (user: TestUser, query = '') =>
    (await api.call(user, 'GET', `/workspaces/${ws}/presentations${query}`)).body.items.map((p: { title: string }) => p.title);

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    outsider = await api.register('Outsider');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
  });

  afterAll(async () => {
    await api.close();
  });

  it('creates, reads and lists a presentation', async () => {
    const made = await create(editor, { title: 'Kickoff' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ title: 'Kickoff', permission: 'edit', folderId: null, archivedAt: null });
    expect((await api.call(viewer, 'GET', `/presentations/${made.body.id}`)).body.permission).toBe('view');
    expect(await titles(viewer)).toContain('Kickoff');
  });

  it('starts from a starter theme with a first Title slide, and from nothing when none is named', async () => {
    const themed = await create(editor, { title: 'Dark deck', themeId: 'midnight' });
    expect(themed.status).toBe(201);
    const deck = (await api.call(editor, 'GET', `/presentations/${themed.body.id}/deck`)).body;
    expect(deck.settings.themeId).toBe('midnight');
    expect(deck.themes.map((t: { id: string }) => t.id)).toEqual(['midnight']);
    expect(deck.layouts).toHaveLength(8);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]).toMatchObject({ layoutId: 'title' });
    expect(deck.slides[0].frame.background).toMatchObject({ kind: 'color' });

    const blank = await create(editor, { title: 'Blank deck' });
    const empty = (await api.call(editor, 'GET', `/presentations/${blank.body.id}/deck`)).body;
    expect(empty.slides).toEqual([]);
    expect(empty.settings.themeId).toBe('default');
  });

  it('needs slides.create to create, and slides.edit to change', async () => {
    expect((await create(viewer)).status).toBe(403);
    const made = await create(owner, { title: 'Locked down' });
    expect((await api.call(viewer, 'PATCH', `/presentations/${made.body.id}`, { title: 'Nope' })).status).toBe(403);
    expect((await api.call(viewer, 'DELETE', `/presentations/${made.body.id}`)).status).toBe(403);
  });

  it('refuses everyone outside the workspace, and everyone once Slides is off', async () => {
    const made = await create(owner, { title: 'Internal' });
    expect((await api.call(outsider, 'GET', `/presentations/${made.body.id}`)).status).toBe(404);
    expect((await api.call(outsider, 'GET', `/workspaces/${ws}/presentations`)).status).toBeGreaterThanOrEqual(403);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{slides}' WHERE id = $1`, [ws]);
    expect((await api.call(owner, 'GET', `/workspaces/${ws}/presentations`)).status).toBe(403);
    expect((await api.call(owner, 'GET', `/presentations/${made.body.id}`)).status).toBe(404);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [ws]);
  });

  it('hides a locked presentation from the list, the tree and by id', async () => {
    const made = await create(owner, { title: 'Leads only' });
    const lock = await api.call(owner, 'PUT', `/presentations/${made.body.id}/access`, {
      access: 'allow',
      entries: [{ userId: editor.id, permission: 'edit' }],
    });
    expect(lock.status).toBe(200);
    expect(await titles(editor)).toContain('Leads only');
    expect(await titles(viewer)).not.toContain('Leads only');
    expect((await api.call(viewer, 'GET', `/presentations/${made.body.id}`)).status).toBe(404);
    expect((await api.call(viewer, 'GET', `/presentations/${made.body.id}/deck`)).status).toBe(404);
    expect((await api.call(viewer, 'POST', `/presentations/${made.body.id}/duplicate`)).status).toBe(404);
    const unfiled = (tree: { body: { unfiledCount: number } }) => tree.body.unfiledCount;
    const before = unfiled(await api.call(viewer, 'GET', `/workspaces/${ws}/slide-tree`));
    await api.call(owner, 'PUT', `/presentations/${made.body.id}/access`, { access: 'open' });
    expect(unfiled(await api.call(viewer, 'GET', `/workspaces/${ws}/slide-tree`))).toBe(before + 1);
  });

  it('files into Slides folders only, and lists a folder a page at a time', async () => {
    const folder = (await api.call(owner, 'POST', `/workspaces/${ws}/folders`, { name: 'Decks', app: 'slides' })).body;
    expect(folder.app).toBe('slides');
    const docsFolder = (await api.call(owner, 'POST', `/workspaces/${ws}/folders`, { name: 'Docs' })).body;
    expect((await create(owner, { title: 'Wrong', folderId: docsFolder.id })).status).toBe(404);

    const filed = await create(editor, { title: 'Filed', folderId: folder.id });
    expect(filed.body.folderId).toBe(folder.id);
    expect(await titles(owner, '?unfiled=true')).not.toContain('Filed');

    const contents = await api.call(viewer, 'GET', `/folders/${folder.id}/presentations`);
    expect(contents.body.items.map((p: { title: string }) => p.title)).toEqual(['Filed']);
    const tree = await api.call(viewer, 'GET', `/workspaces/${ws}/slide-tree`);
    expect(tree.body.folders.find((f: { id: string }) => f.id === folder.id).presentationCount).toBe(1);

    const moved = await api.call(editor, 'PATCH', `/presentations/${filed.body.id}`, { folderId: null });
    expect(moved.body.folderId).toBeNull();
    expect(await titles(owner, '?unfiled=true')).toContain('Filed');
  });

  it('renames and sets an icon', async () => {
    const made = await create(owner, { title: 'Before' });
    const patched = await api.call(owner, 'PATCH', `/presentations/${made.body.id}`, { title: 'After', icon: '🎤' });
    expect(patched.body).toMatchObject({ title: 'After', icon: '🎤' });
    expect((await api.call(owner, 'PATCH', `/presentations/${made.body.id}`, { icon: null })).body.icon).toBeNull();
  });

  it('archives without deleting, and restores', async () => {
    const made = await create(owner, { title: 'Old news' });
    await api.call(owner, 'PATCH', `/presentations/${made.body.id}`, { archived: true });
    expect(await titles(owner)).not.toContain('Old news');
    expect(await titles(owner, '?archived=true')).toContain('Old news');
    const [row] = await api.sql('SELECT id FROM presentations WHERE id = $1', [made.body.id]);
    expect(row).toBeDefined();
    await api.call(owner, 'PATCH', `/presentations/${made.body.id}`, { archived: false });
    expect(await titles(owner)).toContain('Old news');
  });

  it('duplicates a presentation, slides included, as a copy of the copier', async () => {
    const made = await create(owner, { title: 'Original' });
    await api.sql(`UPDATE presentations SET ydoc = $2, search_text = 'hello' WHERE id = $1`, [made.body.id, Buffer.from([0, 0])]);
    const copy = await api.call(editor, 'POST', `/presentations/${made.body.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: 'Copy of Original', access: 'inherit', permission: 'edit' });
    const [row] = await api.sql<{ ydoc: Buffer; search_text: string; created_by: string }>(
      'SELECT ydoc, search_text, created_by FROM presentations WHERE id = $1',
      [copy.body.id],
    );
    expect(row.search_text).toBe('hello');
    expect(row.created_by).toBe(editor.id);
    expect(Buffer.from(row.ydoc)).toEqual(Buffer.from([0, 0]));
    // A viewer may not make copies.
    expect((await api.call(viewer, 'POST', `/presentations/${made.body.id}/duplicate`)).status).toBe(403);
  });

  it('serves the deck as a snapshot', async () => {
    const made = await create(owner, { title: 'Empty deck' });
    const deck = await api.call(viewer, 'GET', `/presentations/${made.body.id}/deck`);
    expect(deck.status).toBe(200);
    expect(deck.body).toMatchObject({ id: made.body.id, title: 'Empty deck', slides: [] });
  });

  it('deletes', async () => {
    const made = await create(owner, { title: 'Doomed' });
    expect((await api.call(owner, 'DELETE', `/presentations/${made.body.id}`)).status).toBe(204);
    expect((await api.call(owner, 'GET', `/presentations/${made.body.id}`)).status).toBe(404);
  });
});
