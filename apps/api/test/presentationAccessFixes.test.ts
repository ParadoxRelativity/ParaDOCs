import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSlide, readSlideOrder } from '@paradocs/shared';
import { startApi, type Api, type TestUser } from './harness.js';

// A one pixel PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Who reaches a deck by role, what a copy's readers may see, and storing an imported deck. */
describe('presentation access, copies and imports', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let member: TestUser;
  let ws: string;

  const deck = async (title = 'Deck') => (await api.call(owner, 'POST', `/workspaces/${ws}/presentations`, { title })).body.id as string;
  const multipart = (fields: Record<string, string>, file: Buffer, name: string, type: string) => {
    const boundary = '----fixes';
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    const head = `${parts.join('')}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`;
    return {
      payload: Buffer.concat([Buffer.from(head), file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  };
  const send = async (user: TestUser, method: 'POST' | 'PUT', url: string, body: ReturnType<typeof multipart>) => {
    const res = await api.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${user.token}`, 'content-type': body.contentType },
      payload: body.payload,
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const picture = (user: TestUser, presentationId: string) =>
    send(user, 'POST', `/api/workspaces/${ws}/uploads`, multipart({ presentationId }, PNG, 'pic.png', 'image/png'));
  const fetchFile = async (user: TestUser, url: string) =>
    (await api.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.token}` } })).statusCode;
  const importDeck = (user: TestUser, id: string, update: Uint8Array) =>
    send(user, 'PUT', `/api/presentations/${id}/import`, multipart({}, Buffer.from(update), 'deck.bin', 'application/octet-stream'));
  const giveRole = async (user: TestUser, name: string, permissions: string[]) => {
    const [role] = await api.sql<{ id: string }>(
      'INSERT INTO workspace_roles (workspace_id, name, permissions) VALUES ($1, $2, $3) RETURNING id',
      [ws, name, permissions],
    );
    await api.sql('UPDATE workspace_members SET role_id = $3 WHERE workspace_id = $1 AND user_id = $2', [ws, user.id, role.id]);
  };

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    member = await api.register('Member');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
    await api.join(member, ws, 'Viewer');
  });

  afterAll(async () => {
    await api.close();
  });

  it("caps a deck by the role's Slides permissions, not its Docs ones", async () => {
    const id = await deck('Slides only');
    await giveRole(member, 'Slide viewer', ['slides.view']);
    expect((await api.call(member, 'GET', `/presentations/${id}`)).body.permission).toBe('view');

    await giveRole(member, 'Docs editor', ['docs.view', 'docs.edit']);
    expect((await api.call(member, 'GET', `/presentations/${id}`)).status).toBe(404);
  });

  it("lets a copy's readers see its pictures, even after the original is gone", async () => {
    const original = await deck('Locked original');
    const { body: pic } = await picture(owner, original);
    await api.call(owner, 'PUT', `/presentations/${original}/access`, { access: 'allow', entries: [{ userId: editor.id, permission: 'edit' }] });
    expect(await fetchFile(viewer, pic.url)).toBe(404);

    const duplicated = await api.call(editor, 'POST', `/presentations/${original}/duplicate`, {});
    expect(duplicated.status, JSON.stringify(duplicated.body)).toBe(201);
    const copy = duplicated.body.id as string;
    expect((await api.call(viewer, 'GET', `/presentations/${copy}`)).status).toBe(200);
    expect(await fetchFile(viewer, pic.url)).toBe(200);

    await api.call(owner, 'DELETE', `/presentations/${original}`);
    expect(await fetchFile(viewer, pic.url)).toBe(200);
    const unattached = (await api.call(owner, 'GET', `/workspaces/${ws}/uploads?unattached=true`)).body.uploads as { id: string }[];
    expect(unattached.some((u) => u.id === pic.id)).toBe(false);
  });

  it('stores an imported deck in a new presentation at once, and only in an empty one', async () => {
    const doc = new Y.Doc();
    createSlide(doc, {});
    createSlide(doc, {});
    const update = Y.encodeStateAsUpdate(doc);

    const id = await deck('Imported');
    expect((await importDeck(viewer, id, update)).status).toBe(403);
    expect((await importDeck(owner, id, Buffer.from('not a deck'))).status).toBe(400);
    expect((await importDeck(owner, id, update)).status).toBe(204);
    expect((await api.call(owner, 'GET', `/presentations/${id}/deck`)).body.slides).toHaveLength(2);

    // A second import would overwrite slides someone may already have edited.
    expect((await importDeck(owner, id, update)).status).toBe(409);
    const [{ ydoc }] = await api.sql<{ ydoc: Buffer }>('SELECT ydoc FROM presentations WHERE id = $1', [id]);
    const stored = new Y.Doc();
    Y.applyUpdate(stored, new Uint8Array(ydoc));
    expect(readSlideOrder(stored)).toHaveLength(2);
  });
});
