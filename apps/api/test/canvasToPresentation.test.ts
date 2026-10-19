import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_ELEMENTS, readDeck } from '@paradocs/shared';
import { startApi, type Api, type TestUser } from './harness.js';

/** A canvas's frames become a deck. */
describe('canvas to presentation', () => {
  let api: Api;
  let owner: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;

  async function canvas(frames: number, extra: Record<string, unknown>[] = []) {
    const made = await api.call(owner, 'POST', `/workspaces/${ws}/documents`, { title: 'Board', mode: 'canvas' });
    const doc = new Y.Doc();
    const elements = doc.getMap<Y.Map<unknown>>(CANVAS_ELEMENTS);
    const put = (el: Record<string, unknown>) => elements.set(String(el.id), new Y.Map(Object.entries(el)));
    // Written out of order: the frames' own numbers decide the slides.
    for (let i = frames - 1; i >= 0; i--) {
      put({ id: `f${i}`, type: 'frame', name: `Frame ${i + 1}`, order: i, x: 0, y: i * 1000, width: 960, height: 540, z: 0 });
      put({ id: `n${i}`, type: 'note', text: `Note ${i + 1}`, x: 20, y: i * 1000 + 20, width: 200, height: 100, z: 1 });
    }
    for (const el of extra) put(el);
    await api.sql('UPDATE documents SET ydoc = $2 WHERE id = $1', [made.body.id, Buffer.from(Y.encodeStateAsUpdate(doc))]);
    return made.body.id as string;
  }

  async function deckOf(id: string) {
    const [row] = await api.sql<{ ydoc: Buffer }>('SELECT ydoc FROM presentations WHERE id = $1', [id]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.ydoc));
    return readDeck(doc);
  }

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    viewer = await api.register('Viewer');
    outsider = await api.register('Outsider');
    ws = owner.workspaceId;
    await api.join(viewer, ws, 'Viewer');
  });

  afterAll(async () => {
    await api.close();
  });

  it('turns a canvas of 5 frames into a 5-slide deck in the same order', async () => {
    const id = await canvas(5);
    const made = await api.call(owner, 'POST', `/documents/${id}/presentation`, {});
    expect(made.status).toBe(201);
    expect(made.body.title).toBe('Board');
    const deck = await deckOf(made.body.id);
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides.map((s) => (s.elements[0] as { text?: string }).text)).toEqual(['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5']);
  });

  it('copies live references rather than their values', async () => {
    const id = await canvas(1, [
      { id: 'c1', type: 'sheetChart', spreadsheetId: '11111111-1111-4111-8111-111111111111', sheetId: 'main', chartId: '22222222-2222-4222-8222-222222222222', x: 300, y: 20, width: 400, height: 300, z: 2 },
    ]);
    const made = await api.call(owner, 'POST', `/documents/${id}/presentation`, { title: 'Chart deck' });
    expect(made.body.title).toBe('Chart deck');
    const deck = await deckOf(made.body.id);
    expect(deck.slides[0].elements.find((e) => e.type === 'sheetChart')).toMatchObject({ chartId: '22222222-2222-4222-8222-222222222222' });
  });

  it('refuses a canvas with no frames, a page, someone who cannot create decks and a stranger', async () => {
    const empty = await canvas(0);
    expect((await api.call(owner, 'POST', `/documents/${empty}/presentation`, {})).status).toBe(400);
    const page = await api.call(owner, 'POST', `/workspaces/${ws}/documents`, { title: 'Page' });
    expect((await api.call(owner, 'POST', `/documents/${page.body.id}/presentation`, {})).status).toBe(400);
    const id = await canvas(2);
    expect((await api.call(viewer, 'POST', `/documents/${id}/presentation`, {})).status).toBe(403);
    expect((await api.call(outsider, 'POST', `/documents/${id}/presentation`, {})).status).toBe(404);
  });
});
