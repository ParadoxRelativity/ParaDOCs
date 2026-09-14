import { Hocuspocus } from '@hocuspocus/server';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import {
  CANVAS_ELEMENTS,
  COLLAB_FRAGMENT,
  DEFAULT_SHEET_NAME,
  MAIN_SHEET_ID,
  SHEET_INFO,
  canvasSearchText,
  normalizeBlocks,
  sheetIdFromCollabName,
  sheetMapName,
  workbookSearchText,
  type CanvasElement,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { mentionsInBlocks, mentionsInCanvas, namesFor, recordMentions } from '../lib/documentMentions.js';
import { spreadsheetAccessForUser } from '../lib/spreadsheetAccess.js';
import { setLiveDocumentLookup } from '../lib/liveDocuments.js';
import { documentSchema } from './documentSchema.js';
import {
  SESSION_COOKIE,
  documentAccessForUser,
  resolveSession,
  roleAtLeast,
  type SessionUser,
} from '../plugins/session.js';

export const COLLAB_PATH = '/collab';

/**
 * Runs BlockNote's schema server side so the Y.Doc can be converted back into
 * blocks and markdown. Creating it is expensive, so there is exactly one.
 */
const serverEditor = ServerBlockNoteEditor.create({ schema: documentSchema });

interface CollabContext {
  user: SessionUser;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * Collaborative editing.
 *
 * While a document is open the Y.Doc is the source of truth. On every save it is
 * written to documents.ydoc, and documents.body / body_md are re-derived from it
 * so search, export and the REST API keep seeing current content.
 *
 * Spreadsheets ride the same socket. They are a different application with a
 * different table, and the only thing shared is this machinery, so they are
 * told apart by a "sheet:" prefix on the document name and handled in their own
 * branch of each hook. Neither app has to know how the other stores anything.
 */
export function createCollabServer(log: FastifyBaseLogger) {
  const hocuspocus = new Hocuspocus({
    name: 'paradocs',
    // Persist after 2s of quiet, and at least every 10s of continuous typing.
    debounce: 2000,
    maxDebounce: 10_000,
    quiet: true,

    async onConnect({ documentName, context, connection }) {
      const { user } = context as CollabContext;
      const sheetId = sheetIdFromCollabName(documentName);
      const access = sheetId
        ? await spreadsheetAccessForUser(user.id, sheetId)
        : await documentAccessForUser(user.id, documentName);
      if (!access) {
        // Rejects the connection rather than silently serving an empty document.
        throw new Error('No access to this document');
      }
      // Viewers may follow along and see cursors, but their edits are refused.
      connection.readOnly = !roleAtLeast(access.role, 'editor');
    },

    /**
     * Seeds the document Hocuspocus just created.
     *
     * The update is applied to the `document` we are handed rather than to a
     * fresh Y.Doc that gets returned. Hocuspocus recognises a returned document
     * by `constructor.name === 'Doc'`, which any bundler that renames classes
     * quietly breaks — in the desktop build the class is emitted as `Doc2`, so
     * a returned document was discarded and every document opened blank.
     * Mutating the one we are given does not depend on the class name at all.
     */
    async onLoadDocument({ documentName, document }) {
      const sheetId = sheetIdFromCollabName(documentName);
      if (sheetId) {
        // A spreadsheet has nothing to seed from: an empty grid is a valid
        // grid, so a new one simply starts blank.
        const { rows } = await query<{ ydoc: Buffer | null }>(
          'SELECT ydoc FROM spreadsheets WHERE id = $1',
          [sheetId],
        );
        if (rows[0]?.ydoc) Y.applyUpdate(document, new Uint8Array(rows[0].ydoc));
        return;
      }

      const { rows } = await query<{ ydoc: Buffer | null; body: unknown; mode: string }>(
        'SELECT ydoc, body, mode FROM documents WHERE id = $1',
        [documentName],
      );
      const row = rows[0];
      if (!row) return;

      if (row.ydoc) {
        Y.applyUpdate(document, new Uint8Array(row.ydoc));
        return;
      }

      // A canvas has no blocks to seed from; it starts empty.
      if (row.mode === 'canvas') return;

      // First collaborative session for this document: seed the Y.Doc from the
      // blocks that were saved before collaboration existed.
      const blocks = normalizeBlocks(row.body);
      if (blocks) {
        try {
          const seeded = serverEditor.blocksToYDoc(blocks as never, COLLAB_FRAGMENT);
          Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded));
        } catch (err) {
          log.warn({ err, documentName }, 'could not seed collaborative document from stored blocks');
        }
      }
    },

    async onStoreDocument({ documentName, document, context }) {
      const { user } = (context ?? {}) as Partial<CollabContext>;
      const update = Y.encodeStateAsUpdate(document);
      const state = Buffer.from(update);

      const sheetId = sheetIdFromCollabName(documentName);
      if (sheetId) {
        // What people typed is what a spreadsheet contributes to search, across
        // every sheet and under each sheet's name. A formula is indexed as its
        // text, since the value it works out to is never stored anywhere.
        const sheets: { id: string; name: string; order: number }[] = [];
        document.getMap(SHEET_INFO).forEach((value, id) => {
          if (!(value instanceof Y.Map)) return;
          sheets.push({ id, name: String(value.get('name') ?? id), order: Number(value.get('order') ?? 0) });
        });
        // A spreadsheet nobody has added a second sheet to has no list at all:
        // it is one sheet, stored under the original names.
        if (sheets.length === 0) sheets.push({ id: MAIN_SHEET_ID, name: DEFAULT_SHEET_NAME, order: 0 });
        sheets.sort((a, b) => a.order - b.order);

        const searchText = workbookSearchText(
          sheets.map((sheet) => {
            const cells: Record<string, string> = {};
            document.getMap(sheetMapName('cells', sheet.id)).forEach((value, key) => {
              if (typeof value === 'string' && value) cells[key] = value;
            });
            return { name: sheet.name, cells };
          }),
        );

        await query(
          `UPDATE spreadsheets
              SET ydoc = $2,
                  search_text = $3,
                  last_edited_by = COALESCE($4, last_edited_by),
                  updated_at = now()
            WHERE id = $1`,
          [sheetId, state, searchText, user?.id ?? null],
        );
        return;
      }

      const { rows } = await query<{ mode: string }>('SELECT mode FROM documents WHERE id = $1', [
        documentName,
      ]);
      const mode = rows[0]?.mode ?? 'page';

      // Derive the searchable representations. If conversion fails we still keep
      // the Y.Doc, because that is the content the users actually have.
      let body: unknown[] | null = null;
      let markdown: string | null = null;

      // Who has been tagged by name, gathered here and recorded after the
      // document itself is saved.
      let mentioned: string[] = [];

      if (mode === 'canvas') {
        // A canvas has no blocks. Its text digest is what search indexes.
        const elements = [...document.getMap(CANVAS_ELEMENTS).values()]
          .map((value) => (value instanceof Y.Map ? (value.toJSON() as CanvasElement) : null))
          .filter((el): el is CanvasElement => Boolean(el && el.type));
        mentioned = mentionsInCanvas(elements);
        // A board stores a tag as an id, so the names have to be looked up
        // before its text can be indexed as something people would search for.
        markdown = canvasSearchText(elements, await namesFor(mentioned));
        body = [];
      } else {
        try {
          // Convert a throwaway copy, never the live document. yDocToBlocks binds
          // y-prosemirror to the doc it is given and normalizes it to the schema,
          // which mutates it — doing that to the live document silently reverted
          // whichever collaborator's edit had not yet been normalized.
          const snapshot = new Y.Doc();
          Y.applyUpdate(snapshot, update);
          body = serverEditor.yDocToBlocks(snapshot, COLLAB_FRAGMENT);
          markdown = await serverEditor.blocksToMarkdownLossy(body as never);
          mentioned = mentionsInBlocks(body);
          snapshot.destroy();
        } catch (err) {
          log.error({ err, documentName }, 'could not derive blocks from collaborative document');
        }
      }

      await query(
        `UPDATE documents
            SET ydoc = $2,
                body = COALESCE($3::jsonb, body),
                body_md = COALESCE($4, body_md),
                last_edited_by = COALESCE($5, last_edited_by),
                updated_at = now()
          WHERE id = $1`,
        [documentName, state, body ? JSON.stringify(body) : null, markdown, user?.id ?? null],
      );

      // After the save, so a tag is never announced for a document whose own
      // write failed. A failure here costs a notification, not the work.
      if (mentioned.length > 0) {
        try {
          await recordMentions(documentName, mentioned, user?.id ?? null);
        } catch (err) {
          log.warn({ err, documentName }, 'could not record document mentions');
        }
      }
    },
  });

  // Values referenced from elsewhere should come from the grid being edited,
  // not from the save a couple of seconds behind it.
  setLiveDocumentLookup((name) => hocuspocus.documents.get(name));

  const wss = new WebSocketServer({ noServer: true });

  /**
   * Authenticates the session cookie before handing the socket to Hocuspocus.
   * Per-document authorization happens in onConnect, where the name is known.
   */
  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await resolveSession(token) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request, { user } satisfies CollabContext);
    });
  }

  function attach(server: Server) {
    server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '').split('?')[0];
      // Other upgrade listeners (Vite HMR in dev) must still see their sockets.
      if (path !== COLLAB_PATH && !path.startsWith(`${COLLAB_PATH}/`)) return;
      handleUpgrade(request, socket as Duplex, head).catch((err) => {
        log.error({ err }, 'collaboration upgrade failed');
        socket.destroy();
      });
    });
  }

  async function close() {
    await hocuspocus.destroy();
    wss.close();
  }

  return { attach, close, hocuspocus };
}
