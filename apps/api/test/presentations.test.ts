import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSlide, setSlideElement, slidesCollabName, ELEMENT_BODY_KEY, SLIDE_ELEMENTS_KEY, slideMapName } from '@paradocs/shared';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * Presentations: the table and its access rules, the roles migration 0052
 * gave the Slides permissions, and the collaboration server persisting a deck.
 */
describe('presentations', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let folderId: string;

  async function presentation(extra: { folder?: string | null; access?: string; title?: string } = {}): Promise<string> {
    const [row] = await api.sql<{ id: string }>(
      `INSERT INTO presentations (workspace_id, title, folder_id, access, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, extra.title ?? 'Deck', extra.folder ?? null, extra.access ?? 'inherit', owner.id],
    );
    return row.id;
  }

  async function slidesFolder(name: string): Promise<string> {
    const [folder] = await api.sql<{ id: string }>(
      `INSERT INTO folders (workspace_id, name, app) VALUES ($1, $2, 'slides') RETURNING id`,
      [workspaceId, name],
    );
    return folder.id;
  }

  /** A paragraph of plain text, as the editor and the notes both store one. */
  function paragraph(text: string): Y.XmlElement {
    const p = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    p.insert(0, [run]);
    run.insert(0, text);
    return p;
  }

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    outsider = await api.register('Outsider');
    workspaceId = owner.workspaceId;
    await api.join(editor, workspaceId, 'Editor');
    await api.join(viewer, workspaceId, 'Viewer');
    folderId = await slidesFolder('Decks');
  });

  afterAll(async () => {
    await api.close();
  });

  describe('slides roles', () => {
    it('seeds Editor and Viewer with the Slides permissions', async () => {
      const roles = await api.sql<{ name: string; permissions: string[] }>(
        `SELECT name, permissions FROM workspace_roles WHERE workspace_id = $1 AND name IN ('Editor', 'Viewer')`,
        [workspaceId],
      );
      const byName = Object.fromEntries(roles.map((r) => [r.name, r.permissions]));
      expect(byName.Editor).toEqual(expect.arrayContaining(['slides.view', 'slides.edit', 'slides.create', 'slides.delete', 'slides.present']));
      expect(byName.Viewer).toContain('slides.view');
      expect(byName.Viewer).not.toContain('slides.edit');
    });

    it('backfills custom roles from what they could do with spreadsheets', async () => {
      const make = async (name: string, permissions: string[]) => {
        const [row] = await api.sql<{ id: string }>(
          `INSERT INTO workspace_roles (workspace_id, name, permissions, position) VALUES ($1, $2, $3, 9) RETURNING id`,
          [workspaceId, name, permissions],
        );
        return row.id;
      };
      const ids = {
        none: await make('NoSheets', ['docs.view']),
        view: await make('SheetsView', ['sheets.view']),
        edit: await make('SheetsEdit', ['sheets.view', 'sheets.edit']),
        create: await make('SheetsCreate', ['sheets.view', 'sheets.edit', 'sheets.create']),
        all: await make('SheetsAll', ['sheets.view', 'sheets.edit', 'sheets.create', 'sheets.delete']),
      };

      // Run the backfill statements of 0052 again, as they would run on an existing install.
      const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/0052_slides_app.sql'), 'utf8');
      const backfill = migration.slice(migration.indexOf('UPDATE workspace_roles'));
      for (const statement of backfill.split(/;\s*\n/).filter((s) => s.trim())) await api.sql(statement);

      const permissionsOf = async (id: string) =>
        (await api.sql<{ permissions: string[] }>('SELECT permissions FROM workspace_roles WHERE id = $1', [id]))[0].permissions.filter((p) =>
          p.startsWith('slides.'),
        );
      expect(await permissionsOf(ids.none)).toEqual([]);
      expect(await permissionsOf(ids.view)).toEqual(['slides.view']);
      expect(await permissionsOf(ids.edit)).toEqual(['slides.view', 'slides.edit']);
      expect((await permissionsOf(ids.create)).sort()).toEqual(['slides.create', 'slides.edit', 'slides.present', 'slides.view']);
      expect((await permissionsOf(ids.all)).sort()).toEqual(['slides.create', 'slides.delete', 'slides.edit', 'slides.present', 'slides.view']);
    });
  });

  describe('access', () => {
    it('lets members open and edit by role, and keeps outsiders out', async () => {
      const { presentationAccessForUser } = await import('../src/lib/presentationAccess.js');
      const id = await presentation();
      expect(await presentationAccessForUser(owner.id, id)).toMatchObject({ workspaceId, canEdit: true });
      expect(await presentationAccessForUser(editor.id, id)).toMatchObject({ canEdit: true });
      expect(await presentationAccessForUser(viewer.id, id)).toMatchObject({ canEdit: false });
      expect(await presentationAccessForUser(outsider.id, id)).toBeNull();
      expect(await presentationAccessForUser(editor.id, 'not-a-uuid')).toBeNull();
    });

    it('follows a lock on the presentation and on its folder', async () => {
      const { presentationAccessForUser } = await import('../src/lib/presentationAccess.js');
      const own = await presentation({ access: 'allow' });
      expect(await presentationAccessForUser(editor.id, own)).toBeNull();
      await api.sql(`INSERT INTO access_entries (presentation_id, user_id, level) VALUES ($1, $2, 1)`, [own, editor.id]);
      expect(await presentationAccessForUser(editor.id, own)).toMatchObject({ canEdit: false });

      const filed = await presentation({ folder: folderId });
      expect(await presentationAccessForUser(editor.id, filed)).toMatchObject({ canEdit: true });
      await api.sql(`UPDATE folders SET access = 'deny' WHERE id = $1`, [folderId]);
      await api.sql(`INSERT INTO access_entries (folder_id, user_id, level) VALUES ($1, $2, 1)`, [folderId, editor.id]);
      expect(await presentationAccessForUser(editor.id, filed)).toMatchObject({ canEdit: false });
      // An open presentation ignores the folder's lock.
      await api.sql(`UPDATE presentations SET access = 'open' WHERE id = $1`, [filed]);
      expect(await presentationAccessForUser(editor.id, filed)).toMatchObject({ canEdit: true });
      await api.sql(`UPDATE folders SET access = 'inherit' WHERE id = $1`, [folderId]);
      await api.sql('DELETE FROM access_entries WHERE folder_id = $1', [folderId]);
    });

    it('is refused when Slides is turned off for the workspace', async () => {
      const { presentationAccessForUser } = await import('../src/lib/presentationAccess.js');
      const id = await presentation();
      await api.sql(`UPDATE workspaces SET disabled_apps = ARRAY['slides'] WHERE id = $1`, [workspaceId]);
      expect(await presentationAccessForUser(owner.id, id)).toBeNull();
      await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [workspaceId]);
      expect(await presentationAccessForUser(owner.id, id)).not.toBeNull();
    });

    it('lets an access entry belong to exactly one target, and removes entries with the presentation', async () => {
      const id = await presentation({ access: 'allow' });
      await api.sql(`INSERT INTO access_entries (presentation_id, user_id, level) VALUES ($1, $2, 2)`, [id, editor.id]);
      await expect(
        api.sql(`INSERT INTO access_entries (presentation_id, user_id, level) VALUES ($1, $2, 2)`, [id, editor.id]),
      ).rejects.toThrow();
      await expect(
        api.sql(`INSERT INTO access_entries (presentation_id, folder_id, user_id, level) VALUES ($1, $2, $3, 2)`, [id, folderId, viewer.id]),
      ).rejects.toThrow();
      await api.sql('DELETE FROM presentations WHERE id = $1', [id]);
      expect(await api.sql('SELECT 1 FROM access_entries WHERE presentation_id = $1', [id])).toHaveLength(0);
    });

    it('is searchable by title and text', async () => {
      const id = await presentation({ title: 'Quarterly roadmap' });
      await api.sql(`UPDATE presentations SET search_text = 'penguins everywhere' WHERE id = $1`, [id]);
      const hits = await api.sql<{ id: string }>(`SELECT id FROM presentations WHERE search @@ plainto_tsquery('english', $1)`, ['penguins']);
      expect(hits.map((h) => h.id)).toContain(id);
    });
  });

  describe('deleting a Slides folder', () => {
    it('keeps its presentations, unfiled', async () => {
      const folder = await slidesFolder('Temp');
      const id = await presentation({ folder });
      const response = await api.call(owner, 'DELETE', `/folders/${folder}`);
      expect(response.status).toBe(204);
      const [row] = await api.sql<{ folder_id: string | null }>('SELECT folder_id FROM presentations WHERE id = $1', [id]);
      expect(row.folder_id).toBeNull();
    });

    it('deletes them with it when asked', async () => {
      const folder = await slidesFolder('Temp2');
      const id = await presentation({ folder });
      const response = await api.call(owner, 'DELETE', `/folders/${folder}?contents=delete`);
      expect(response.status).toBe(200);
      expect(response.body.deleted).toEqual([id]);
    });

    it('will not delete what the caller could not change', async () => {
      const folder = await slidesFolder('Temp3');
      await presentation({ folder, access: 'allow' });
      const response = await api.call(editor, 'DELETE', `/folders/${folder}?contents=delete`);
      expect(response.status).toBe(403);
    });
  });

  describe('collaboration', () => {
    async function server() {
      const { createCollabServer } = await import('../src/collab/server.js');
      const log = { warn() {}, error() {}, info() {}, debug() {} } as never;
      return createCollabServer(log);
    }

    async function edit(collab: Awaited<ReturnType<typeof server>>, id: string, change: (doc: Y.Doc) => void) {
      const connection = await collab.hocuspocus.openDirectConnection(slidesCollabName(id), { user: { id: editor.id } });
      await connection.transact((doc) => change(doc));
      await connection.disconnect();
    }

    it('stores nothing for a presentation that was never opened', async () => {
      const id = await presentation();
      const [row] = await api.sql<{ ydoc: unknown; search_text: string }>('SELECT ydoc, search_text FROM presentations WHERE id = $1', [id]);
      expect(row.ydoc).toBeNull();
      expect(row.search_text).toBe('');
    });

    it('saves a deck with its search text and loads it again after a restart', async () => {
      const id = await presentation();
      const first = await server();
      await edit(first, id, (doc) => {
        const slide = createSlide(doc);
        setSlideElement(doc, slide, { id: 'e1', type: 'text', text: 'Penguin migration', x: 0, y: 0, width: 100, height: 50, z: 0 });
        setSlideElement(doc, slide, { id: 'e2', type: 'richText', x: 0, y: 0, width: 100, height: 50, z: 1 });
        const elements = doc.getMap(slideMapName(slide)).get(SLIDE_ELEMENTS_KEY) as Y.Map<Y.Map<unknown>>;
        (elements.get('e2')!.get(ELEMENT_BODY_KEY) as Y.XmlFragment).insert(0, [paragraph('Iceberg facts')]);
        doc.getXmlFragment(`notes:${slide}`).insert(0, [paragraph('remember the fish')]);
      });
      await first.close();

      const [saved] = await api.sql<{ ydoc: Buffer | null; search_text: string; last_edited_by: string }>(
        'SELECT ydoc, search_text, last_edited_by FROM presentations WHERE id = $1',
        [id],
      );
      expect(saved.ydoc).not.toBeNull();
      expect(saved.last_edited_by).toBe(editor.id);
      expect(saved.search_text).toContain('Penguin migration');
      expect(saved.search_text).toContain('Iceberg facts');
      expect(saved.search_text).toContain('remember the fish');

      // A new server is a restart: it knows only what is in the database.
      const second = await server();
      const { loadDeck } = await import('../src/lib/deck.js');
      const deck = await loadDeck(id);
      expect(deck?.slides).toHaveLength(1);
      expect(deck?.slides[0].elements.map((e) => e.id)).toEqual(['e1', 'e2']);
      let slides = 0;
      await edit(second, id, (doc) => {
        slides = doc.getArray('slideOrder').length;
      });
      expect(slides).toBe(1);
      await second.close();
    });

    it('reads the live copy in preference to the saved one', async () => {
      const id = await presentation();
      const collab = await server();
      const connection = await collab.hocuspocus.openDirectConnection(slidesCollabName(id), { user: { id: editor.id } });
      await connection.transact((doc) => {
        createSlide(doc, { id: 'live-slide' });
      });
      const { loadDeck } = await import('../src/lib/deck.js');
      expect((await loadDeck(id))?.slides.map((s) => s.id)).toEqual(['live-slide']);
      await connection.disconnect();
      await collab.close();
      expect(await loadDeck('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });
});
