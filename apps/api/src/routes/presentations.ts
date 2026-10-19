import type { FastifyPluginAsync } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import {
  CANVAS_ELEMENTS,
  CONTENTS_PAGE_SIZE,
  DEFAULT_SLIDE_SIZE,
  canvasFramesToSlides,
  deckSearchText,
  readDeck,
  writeFrameSlides,
  type CanvasElement,
  MAX_CONTENTS_PAGE_SIZE,
  createPresentationSchema,
  duplicatePresentationSchema,
  slidesCollabName,
  updatePresentationSchema,
  type ContentsPage,
  type PresentationSummary,
} from '@paradocs/shared';
import { CURSOR_TEXT, decodeCursor, encodeCursor, isUuid } from '../lib/cursor.js';
import { query } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { assertDocumentAccess, assertWorkspaceAccess } from '../plugins/session.js';
import { assertFolderAccess, assertMoveKeepsAccess, assertPresentationAccess, presentationLevelSql, roleIdSql } from '../lib/access.js';
import { presentationSummaryColumns } from '../lib/documentColumns.js';
import { treeChanged } from '../lib/treeEvents.js';
import { loadDeck } from '../lib/deck.js';
import { liveDocument } from '../lib/liveDocuments.js';
import { activeShows } from '../lib/liveShows.js';

/**
 * Presentations, as their own application.
 *
 * As spreadsheets are: a name, filed in the Slides app's own folders and
 * locked the way a document is. The slides live in the Y.Doc the collaboration
 * server owns, so nothing here writes slide content over REST.
 */

/** A presentation as `user` sees it. */
async function fetchPresentation(id: string, userId: string) {
  const { rows } = await query(
    `SELECT ${presentationSummaryColumns('$2', roleIdSql('$2', 'p.workspace_id'))} FROM presentations p WHERE p.id = $1`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Presentation not found');
  return rows[0];
}

const presentationListSchema = z.object({
  archived: z.enum(['true', 'false']).optional(),
  unfiled: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONTENTS_PAGE_SIZE).default(CONTENTS_PAGE_SIZE),
});

export const presentationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * A workspace's presentations the reader may see, most recently touched
   * first, a page at a time: the archived ones with `archived=true`, and only
   * those in no folder with `unfiled=true`.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/workspaces/:id/presentations',
    async (req): Promise<ContentsPage<PresentationSummary>> => {
      const { roleId } = await assertWorkspaceAccess(req, req.params.id, 'slides.view', 'slides');
      const input = parse(presentationListSchema, req.query ?? {});
      const limit = input.limit ?? CONTENTS_PAGE_SIZE;
      const after = input.cursor ? decodeCursor(input.cursor, (v) => CURSOR_TEXT.timestamp.test(v), isUuid) : null;
      const { rows } = await query<PresentationSummary & { sortValue: string }>(
        `SELECT ${presentationSummaryColumns('$3', '$4')}, p.updated_at::text AS "sortValue"
           FROM presentations p
          WHERE p.workspace_id = $1
            AND (p.archived_at IS NOT NULL) = $2
            AND ($5::boolean IS NOT TRUE OR p.folder_id IS NULL)
            AND ${presentationLevelSql('$3', '$4')} > 0
            AND ($6::timestamptz IS NULL OR (p.updated_at, p.id) < ($6::timestamptz, $7::uuid))
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT $8`,
        [
          req.params.id,
          input.archived === 'true',
          req.user!.id,
          roleId,
          input.unfiled === 'true',
          after?.[0] ?? null,
          after?.[1] ?? null,
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(({ sortValue: _, ...deck }) => deck),
        nextCursor: rows.length > limit && last ? encodeCursor(last.sortValue, last.id) : null,
      };
    },
  );

  /** Presentations being shown live in the workspace that the reader may follow. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/live-shows', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.view', 'slides');
    return activeShows(req.user!.id, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/presentations', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
    const input = parse(createPresentationSchema, req.body ?? {});
    // Filing into a folder takes being allowed to change what is in it.
    if (input.folderId) await assertFolderAccess(req, input.folderId, 'edit', req.params.id, 'slides');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO presentations (workspace_id, folder_id, title, icon, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.params.id, input.folderId ?? null, input.title || 'Untitled', input.icon ?? null, req.user!.id],
    );
    treeChanged(req.params.id, 'slides');
    reply.status(201);
    return fetchPresentation(rows[0].id, req.user!.id);
  });

  /**
   * A new presentation from a canvas: one slide per frame, in frame order, with
   * what lies inside each frame copied and scaled to the slide. Needs the right
   * to see the canvas and to create presentations; the canvas is not changed.
   * Live spreadsheet, work item and document elements are copied as references,
   * so each viewer of the deck still sees only what they may see.
   */
  app.post<{ Params: { id: string } }>('/documents/:id/presentation', async (req, reply) => {
    const access = await assertDocumentAccess(req, req.params.id);
    await assertWorkspaceAccess(req, access.workspaceId, 'slides.create', 'slides');
    const input = parse(createPresentationSchema, req.body ?? {});
    if (input.folderId) await assertFolderAccess(req, input.folderId, 'edit', access.workspaceId, 'slides');

    const { rows: source } = await query<{ title: string; mode: string; ydoc: Buffer | null }>(
      'SELECT title, mode, ydoc FROM documents WHERE id = $1',
      [req.params.id],
    );
    if (!source[0]) throw notFound('Document not found');
    if (source[0].mode !== 'canvas') throw badRequest('Only a canvas has frames to turn into slides');

    // The open canvas is newer than the saved copy by up to the save debounce.
    const board = liveDocument(req.params.id) ?? new Y.Doc();
    if (!liveDocument(req.params.id) && source[0].ydoc) Y.applyUpdate(board, new Uint8Array(source[0].ydoc));
    const elements = [...board.getMap(CANVAS_ELEMENTS).values()]
      .map((value) => (value instanceof Y.Map ? (value.toJSON() as CanvasElement) : null))
      .filter((el): el is CanvasElement => Boolean(el && el.type));
    if (!liveDocument(req.params.id)) board.destroy();

    const slides = canvasFramesToSlides(elements, DEFAULT_SLIDE_SIZE);
    if (slides.length === 0) throw badRequest('Add a frame to the canvas first: each frame becomes a slide');

    const deck = new Y.Doc();
    try {
      writeFrameSlides(deck, slides);
      const { rows } = await query<{ id: string }>(
        `INSERT INTO presentations (workspace_id, folder_id, title, icon, ydoc, search_text, created_by, last_edited_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        [
          access.workspaceId,
          input.folderId ?? null,
          input.title || source[0].title || 'Untitled',
          input.icon ?? null,
          Buffer.from(Y.encodeStateAsUpdate(deck)),
          deckSearchText(readDeck(deck).slides),
          req.user!.id,
        ],
      );
      treeChanged(access.workspaceId, 'slides');
      reply.status(201);
      return fetchPresentation(rows[0].id, req.user!.id);
    } finally {
      deck.destroy();
    }
  });

  app.get<{ Params: { id: string } }>('/presentations/:id', async (req) => {
    await assertPresentationAccess(req, req.params.id);
    return fetchPresentation(req.params.id, req.user!.id);
  });

  /**
   * The slides as a read-only snapshot, for the placeholder view and anything
   * that wants to show a deck without opening a collaboration socket.
   */
  app.get<{ Params: { id: string } }>('/presentations/:id/deck', async (req) => {
    await assertPresentationAccess(req, req.params.id);
    const deck = await loadDeck(req.params.id);
    if (!deck) throw notFound('Presentation not found');
    return deck;
  });

  app.patch<{ Params: { id: string } }>('/presentations/:id', async (req) => {
    const { workspaceId, role } = await assertPresentationAccess(req, req.params.id, 'edit');
    const input = parse(updatePresentationSchema, req.body ?? {});

    if (input.folderId !== undefined) {
      if (input.folderId) await assertFolderAccess(req, input.folderId, 'edit', workspaceId, 'slides');
      const { rows: current } = await query<{ access: string; folder_id: string | null }>(
        'SELECT access, folder_id FROM presentations WHERE id = $1',
        [req.params.id],
      );
      await assertMoveKeepsAccess(role, { access: current[0].access, folderId: current[0].folder_id }, input.folderId ?? null);
    }

    await query(
      `UPDATE presentations
          SET title = COALESCE($2, title),
              icon = CASE WHEN $3::boolean THEN $4 ELSE icon END,
              archived_at = CASE
                WHEN $5::boolean IS NULL THEN archived_at
                WHEN $5::boolean THEN COALESCE(archived_at, now())
                ELSE NULL
              END,
              folder_id = CASE WHEN $6::boolean THEN $7::uuid ELSE folder_id END,
              -- Filing it somewhere is not an edit to the slides.
              updated_at = CASE WHEN $2::text IS NULL AND NOT $3::boolean AND $5::boolean IS NULL
                                THEN updated_at ELSE now() END
        WHERE id = $1`,
      [
        req.params.id,
        input.title ?? null,
        input.icon !== undefined,
        input.icon ?? null,
        input.archived ?? null,
        input.folderId !== undefined,
        input.folderId ?? null,
      ],
    );
    treeChanged(workspaceId, 'slides');
    return fetchPresentation(req.params.id, req.user!.id);
  });

  /**
   * A copy of the slides under a new name, filed beside the original unless a
   * folder is given. Its access starts at 'inherit': a copy is the copier's own
   * new deck, not a carrier of the original's lock list.
   */
  app.post<{ Params: { id: string } }>('/presentations/:id/duplicate', async (req, reply) => {
    const { workspaceId } = await assertPresentationAccess(req, req.params.id);
    await assertWorkspaceAccess(req, workspaceId, 'slides.create', 'slides');
    const input = parse(duplicatePresentationSchema, req.body ?? {});
    const { rows: source } = await query<{
      title: string;
      icon: string | null;
      folder_id: string | null;
      ydoc: Buffer | null;
      search_text: string;
    }>('SELECT title, icon, folder_id, ydoc, search_text FROM presentations WHERE id = $1', [req.params.id]);
    if (!source[0]) throw notFound('Presentation not found');
    const folderId = input.folderId === undefined ? source[0].folder_id : input.folderId;
    if (folderId) await assertFolderAccess(req, folderId, 'edit', workspaceId, 'slides');

    // The open deck is newer than the saved copy by up to the save debounce.
    const live = liveDocument(slidesCollabName(req.params.id));
    const ydoc = live ? Buffer.from(Y.encodeStateAsUpdate(live)) : source[0].ydoc;
    const { rows } = await query<{ id: string }>(
      `INSERT INTO presentations (workspace_id, folder_id, title, icon, ydoc, search_text, created_by, last_edited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [
        workspaceId,
        folderId,
        input.title ?? `Copy of ${source[0].title}`.slice(0, 200),
        source[0].icon,
        ydoc,
        source[0].search_text,
        req.user!.id,
      ],
    );
    treeChanged(workspaceId, 'slides');
    reply.status(201);
    return fetchPresentation(rows[0].id, req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/presentations/:id', async (req, reply) => {
    const { workspaceId } = await assertPresentationAccess(req, req.params.id, 'delete');
    await query('DELETE FROM presentations WHERE id = $1', [req.params.id]);
    treeChanged(workspaceId, 'slides');
    reply.status(204);
  });
};
