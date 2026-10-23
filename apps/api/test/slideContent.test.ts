import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

// A one pixel PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Pictures on slides are served on the presentation's terms, and a tag in a deck notifies like a tag in a document. */
describe('slide content', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let ws: string;

  const upload = async (user: TestUser, fields: Record<string, string>) => {
    const boundary = '----slidetest';
    const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const head = `${parts.join('')}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n`;
    const response = await api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/uploads`,
      headers: { authorization: `Bearer ${user.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(head), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    return { status: response.statusCode, body: response.statusCode < 300 ? JSON.parse(response.body) : null };
  };
  const fetchFile = async (user: TestUser, url: string) =>
    (await api.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.token}` } })).statusCode;
  const deck = async (extra: Record<string, unknown> = {}) =>
    (await api.call(owner, 'POST', `/workspaces/${ws}/presentations`, { title: 'Deck', ...extra })).body.id as string;

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
  });

  afterAll(async () => {
    await api.close();
  });

  it('takes a picture for a presentation from someone who may edit it, not from a viewer', async () => {
    const id = await deck();
    expect((await upload(viewer, { presentationId: id })).status).toBe(403);
    const made = await upload(editor, { presentationId: id });
    expect(made.status).toBe(201);
    const [row] = await api.sql<{ presentation_id: string; document_id: string | null }>('SELECT presentation_id, document_id FROM attachments WHERE id = $1', [made.body.id]);
    expect(row).toEqual({ presentation_id: id, document_id: null });
  });

  it('refuses a presentation from another workspace', async () => {
    const other = await api.register('Other');
    const foreign = (await api.call(other, 'POST', `/workspaces/${other.workspaceId}/presentations`, { title: 'Theirs' })).body.id;
    expect((await upload(owner, { presentationId: foreign })).status).toBe(404);
  });

  it('serves the picture to whoever may open the presentation, and to nobody else', async () => {
    const id = await deck();
    const { body } = await upload(owner, { presentationId: id });
    expect(await fetchFile(viewer, body.url)).toBe(200);
    await api.call(owner, 'PUT', `/presentations/${id}/access`, { access: 'allow', entries: [{ userId: editor.id, permission: 'edit' }] });
    expect(await fetchFile(editor, body.url)).toBe(200);
    expect(await fetchFile(viewer, body.url)).toBe(404);
  });

  it('does not list a slide picture as an unattached upload', async () => {
    const id = await deck();
    const { body } = await upload(owner, { presentationId: id });
    const unattached = (await api.call(owner, 'GET', `/workspaces/${ws}/uploads?unattached=true`)).body.uploads as { id: string }[];
    expect(unattached.some((u) => u.id === body.id)).toBe(false);
  });

  it('deletes the pictures only a deleted deck used, file and all', async () => {
    const id = await deck();
    const { body } = await upload(owner, { presentationId: id });
    const onDisk = path.join(process.env.UPLOAD_DIR!, body.url.slice('/uploads/'.length));
    expect(fs.existsSync(onDisk)).toBe(true);
    expect((await api.call(owner, 'DELETE', `/presentations/${id}`)).status).toBe(204);
    expect(await api.sql('SELECT 1 FROM attachments WHERE id = $1', [body.id])).toHaveLength(0);
    expect(fs.existsSync(onDisk)).toBe(false);
  });

  it('keeps a deleted deck\'s pictures that a copy, another deck or a document still shows', async () => {
    const id = await deck();
    const copied = (await upload(owner, { presentationId: id })).body;
    const pasted = (await upload(owner, { presentationId: id })).body;
    const inDocument = (await upload(owner, { presentationId: id })).body;
    const unused = (await upload(owner, { presentationId: id })).body;

    // A copy is linked to every picture; keep only the first linked, to see each way of using one on its own.
    const copy = (await api.call(owner, 'POST', `/presentations/${id}/duplicate`)).body.id as string;
    await api.sql('DELETE FROM presentation_attachments WHERE presentation_id = $1 AND attachment_id <> $2', [copy, copied.id]);
    // A slide pasted into another deck carries the picture's address, unlinked.
    const other = await deck();
    await api.sql('UPDATE presentations SET ydoc = $2 WHERE id = $1', [other, Buffer.from(`..."src":"${pasted.url}"...`)]);
    const doc = (await api.call(owner, 'POST', `/workspaces/${ws}/documents`, { title: 'Notes' })).body.id as string;
    await api.sql('UPDATE documents SET body = $2::jsonb WHERE id = $1', [
      doc,
      JSON.stringify([{ type: 'image', props: { url: inDocument.url }, children: [] }]),
    ]);

    expect((await api.call(owner, 'DELETE', `/presentations/${id}`)).status).toBe(204);
    const left = (await api.sql<{ id: string }>('SELECT id FROM attachments WHERE id = ANY($1::uuid[])', [
      [copied.id, pasted.id, inDocument.id, unused.id],
    ])).map((row) => row.id);
    expect(left.sort()).toEqual([copied.id, pasted.id, inDocument.id].sort());
    // What is kept is still served to those who could see it.
    expect(await fetchFile(viewer, copied.url)).toBe(200);
  });

  it('tells a member they were tagged on a slide, opening the deck there, once, and only if they can open it', async () => {
    const { recordPresentationMentions } = await import('../src/lib/documentMentions.js');
    const id = await deck({ title: 'Roadmap' });
    await recordPresentationMentions(id, [{ userId: viewer.id, slideId: 'slide-7' }, { userId: owner.id, slideId: 'slide-7' }], owner.id);
    const tags = (await api.call(viewer, 'GET', '/notifications')).body.mentions;
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ documentId: id, title: 'Roadmap', app: 'slides', path: `/w/${ws}/sl/${id}?slide=slide-7`, taggedBy: { id: owner.id } });
    // Naming yourself tells nobody, and a second tag does not tell again.
    expect((await api.call(owner, 'GET', '/notifications')).body.mentions).toHaveLength(0);

    // Opening the deck answers the tag.
    await api.call(viewer, 'POST', '/notifications/mentions/read', { documentIds: [id] });
    expect((await api.call(viewer, 'GET', '/notifications')).body.mentions).toHaveLength(0);

    // A deck locked away from someone does not tell them.
    const locked = await deck({ title: 'Private' });
    await api.call(owner, 'PUT', `/presentations/${locked}/access`, { access: 'allow', entries: [{ userId: editor.id, permission: 'edit' }] });
    await recordPresentationMentions(locked, [{ userId: viewer.id, slideId: 's' }], owner.id);
    expect((await api.call(viewer, 'GET', '/notifications')).body.mentions).toHaveLength(0);
  });
});
