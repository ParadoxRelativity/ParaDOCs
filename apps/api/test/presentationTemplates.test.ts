import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyStarterTheme, createSlide, updateMaster } from '@paradocs/shared';
import { startApi, type Api, type TestUser } from './harness.js';

// A one pixel PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Presentation templates: saved from a deck or imported, shared with the workspace, and used to start or restyle decks. */
describe('presentation templates', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;

  const multipart = (fields: Record<string, string>, file: Buffer, name: string, type: string) => {
    const boundary = '----templates';
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
  const upload = (user: TestUser, fields: Record<string, string>) =>
    send(user, 'POST', `/api/workspaces/${ws}/uploads`, multipart(fields, PNG, 'pic.png', 'image/png'));
  const fetchFile = async (user: TestUser, url: string) =>
    (await api.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.token}` } })).statusCode;
  const unattached = async () =>
    ((await api.call(owner, 'GET', `/workspaces/${ws}/uploads?unattached=true`)).body.uploads as { url: string }[]).map((u) => u.url);
  const list = async (user: TestUser) => (await api.call(user, 'GET', `/workspaces/${ws}/presentation-templates`)).body;
  const names = async (user: TestUser) => ((await list(user)) as { name: string }[]).map((t) => t.name);

  /** A deck in the Midnight theme, three slides long, its master's background `background` when given. */
  const deckUpdate = (background?: string) => {
    const doc = new Y.Doc();
    applyStarterTheme(doc, 'midnight');
    if (background) updateMaster(doc, { background: { kind: 'image', url: background } });
    for (let i = 0; i < 3; i++) createSlide(doc, {});
    return Y.encodeStateAsUpdate(doc);
  };
  const newDeck = async (user: TestUser, title: string) => (await api.call(user, 'POST', `/workspaces/${ws}/presentations`, { title })).body.id as string;
  const fillDeck = async (user: TestUser, id: string, update: Uint8Array) => {
    const res = await send(user, 'PUT', `/api/presentations/${id}/import`, multipart({}, Buffer.from(update), 'deck.bin', 'application/octet-stream'));
    expect(res.status, JSON.stringify(res.body)).toBe(204);
  };
  const saveTemplate = (user: TestUser, deckId: string, name: string) =>
    api.call(user, 'POST', `/presentations/${deckId}/template`, { name, description: `${name} look` });

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

  it('saves a deck’s look for the whole workspace, and starts new decks from it with one Title slide', async () => {
    const source = await newDeck(editor, 'Quarterly');
    await fillDeck(editor, source, deckUpdate());
    const saved = await saveTemplate(editor, source, 'Midnight board');
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ name: 'Midnight board', description: 'Midnight board look', createdBy: editor.id, createdByName: 'Editor', canManage: true });
    expect(saved.body.preview.theme.id).toBe('midnight');
    expect(saved.body.preview.samples.map((s: { text: string }) => s.text)).toEqual(['Presentation title', 'Subtitle']);

    expect(await names(viewer)).toContain('Midnight board');
    expect(((await list(viewer)) as { canManage: boolean }[]).every((t) => !t.canManage)).toBe(true);

    const made = await api.call(viewer, 'POST', `/workspaces/${ws}/presentations`, { title: 'From template', templateId: saved.body.id });
    // A viewer may not create presentations at all.
    expect(made.status).toBe(403);
    const fromTemplate = await api.call(editor, 'POST', `/workspaces/${ws}/presentations`, { title: 'From template', templateId: saved.body.id });
    expect(fromTemplate.status).toBe(201);
    const deck = (await api.call(editor, 'GET', `/presentations/${fromTemplate.body.id}/deck`)).body;
    expect(deck.settings.themeId).toBe('midnight');
    expect(deck.themes.map((t: { id: string }) => t.id)).toEqual(['midnight']);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].layoutId).toBe('title');
  });

  it('keeps templates to the workspace', async () => {
    expect((await api.call(outsider, 'GET', `/workspaces/${ws}/presentation-templates`)).status).toBe(404);
    const [template] = await list(owner);
    const elsewhere = await api.call(outsider, 'POST', `/workspaces/${outsider.workspaceId}/presentations`, { templateId: template.id });
    expect(elsewhere.status).toBe(400);
    expect((await api.call(outsider, 'PATCH', `/presentation-templates/${template.id}`, { name: 'Mine now' })).status).toBe(404);
  });

  it('lets whoever saved a template, an owner or an admin rename or delete it, and nobody else', async () => {
    const source = await newDeck(editor, 'Look');
    const { body: template } = await saveTemplate(editor, source, 'Editor look');
    expect((await api.call(viewer, 'PATCH', `/presentation-templates/${template.id}`, { name: 'Viewer look' })).status).toBe(403);
    expect((await api.call(viewer, 'DELETE', `/presentation-templates/${template.id}`)).status).toBe(403);

    const renamed = await api.call(editor, 'PATCH', `/presentation-templates/${template.id}`, { name: 'Renamed look', description: '' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed look', description: '' });
    expect((await list(owner)).find((t: { id: string }) => t.id === template.id).canManage).toBe(true);

    expect((await api.call(owner, 'DELETE', `/presentation-templates/${template.id}`)).status).toBe(204);
    expect(await names(editor)).not.toContain('Renamed look');
    expect((await api.call(editor, 'POST', `/workspaces/${ws}/presentations`, { templateId: template.id })).status).toBe(400);
  });

  it('imports a template: a draft nobody sees, its pictures, then its deck rebuilt to one Title slide', async () => {
    const draft = await api.call(editor, 'POST', `/workspaces/${ws}/presentation-templates`, { name: 'Imported look' });
    expect(draft.status).toBe(201);
    expect(await names(editor)).not.toContain('Imported look');
    expect((await api.call(viewer, 'POST', `/workspaces/${ws}/presentation-templates`, { name: 'Nope' })).status).toBe(403);

    // Only its maker uploads to a draft.
    expect((await upload(owner, { templateId: draft.body.id })).status).toBe(404);
    const { body: picture } = await upload(editor, { templateId: draft.body.id });
    expect(picture.url).toMatch(/^\/uploads\//);

    const content = (user: TestUser, body: Buffer) =>
      send(user, 'PUT', `/api/presentation-templates/${draft.body.id}/content`, multipart({}, body, 'template.bin', 'application/octet-stream'));
    expect((await content(viewer, Buffer.from(deckUpdate(picture.url)))).status).toBe(403);
    expect((await content(editor, Buffer.from('not a deck'))).status).toBe(400);
    const stored = await content(editor, Buffer.from(deckUpdate(picture.url)));
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.preview.slide.frame.background).toEqual({ kind: 'image', url: picture.url });
    expect((await content(editor, Buffer.from(deckUpdate()))).status).toBe(409);
    expect(await names(viewer)).toContain('Imported look');

    const [{ ydoc }] = await api.sql<{ ydoc: Buffer }>('SELECT ydoc FROM presentation_templates WHERE id = $1', [draft.body.id]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(ydoc));
    expect(doc.getArray('slideOrder').length).toBe(1);

    // Its picture is the workspace's, as the template is.
    expect(await fetchFile(viewer, picture.url)).toBe(200);
    expect(await unattached()).not.toContain(picture.url);
  });

  it('keeps a template’s pictures after the deck it came from is deleted, and a deck’s after the template is', async () => {
    const source = await newDeck(owner, 'Branded');
    const { body: picture } = await upload(owner, { presentationId: source });
    await fillDeck(owner, source, deckUpdate(picture.url));
    // Locked to its owner, the picture is theirs alone until it is in a template.
    await api.call(owner, 'PUT', `/presentations/${source}/access`, { access: 'allow', entries: [] });
    expect(await fetchFile(viewer, picture.url)).toBe(404);

    const { body: template } = await saveTemplate(owner, source, 'Branded look');
    expect(await fetchFile(viewer, picture.url)).toBe(200);
    await api.call(owner, 'DELETE', `/presentations/${source}`);
    expect(await fetchFile(viewer, picture.url)).toBe(200);
    expect(await unattached()).not.toContain(picture.url);

    const made = await api.call(editor, 'POST', `/workspaces/${ws}/presentations`, { title: 'Branded deck', templateId: template.id });
    const deck = (await api.call(editor, 'GET', `/presentations/${made.body.id}/deck`)).body;
    expect(deck.master.background).toEqual({ kind: 'image', url: picture.url });

    await api.call(owner, 'DELETE', `/presentation-templates/${template.id}`);
    expect(await fetchFile(editor, picture.url)).toBe(200);
    expect(await unattached()).not.toContain(picture.url);
  });

  it('does not share a picture through a template that its saver cannot see', async () => {
    const locked = await newDeck(owner, 'Owner only');
    const { body: secret } = await upload(owner, { presentationId: locked });
    await api.call(owner, 'PUT', `/presentations/${locked}/access`, { access: 'allow', entries: [] });

    const sneaky = await newDeck(editor, 'Borrowed background');
    await fillDeck(editor, sneaky, deckUpdate(secret.url));
    expect((await saveTemplate(editor, sneaky, 'Borrowed')).status).toBe(201);
    expect(await fetchFile(viewer, secret.url)).toBe(404);
    expect(await fetchFile(editor, secret.url)).toBe(404);
  });

  it('hands an editor a template’s look to apply, and lets the deck’s readers see its pictures', async () => {
    const source = await newDeck(owner, 'Source');
    const { body: picture } = await upload(owner, { presentationId: source });
    await fillDeck(owner, source, deckUpdate(picture.url));
    const { body: template } = await saveTemplate(owner, source, 'Applied look');

    const target = await newDeck(editor, 'Target');
    expect((await api.call(viewer, 'POST', `/presentations/${target}/apply-template`, { templateId: template.id })).status).toBe(403);
    const applied = await api.call(editor, 'POST', `/presentations/${target}/apply-template`, { templateId: template.id });
    expect(applied.status).toBe(200);
    expect(applied.body.theme.id).toBe('midnight');
    expect(applied.body.master.background).toEqual({ kind: 'image', url: picture.url });
    expect(applied.body.layouts.length).toBeGreaterThan(0);
    const [{ count }] = await api.sql<{ count: number }>(
      `SELECT count(*)::int AS count FROM presentation_attachments pa JOIN attachments a ON a.id = pa.attachment_id
        WHERE pa.presentation_id = $1 AND '/uploads/' || a.storage_key = $2`,
      [target, picture.url],
    );
    expect(count).toBe(1);
  });
});
