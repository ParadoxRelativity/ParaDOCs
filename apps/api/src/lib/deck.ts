import * as Y from 'yjs';
import { readDeck, slidesCollabName, type DeckSnapshot } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { liveDocument } from './liveDocuments.js';

/**
 * A presentation read on the server, for anything outside the editor that
 * wants to show what is in it: search snippets, assistant tools and exports.
 *
 * The deck people are editing is read in preference to the saved copy, so a
 * reader a second after someone typed sees what they typed.
 */

export interface Deck extends DeckSnapshot {
  id: string;
  title: string;
  workspaceId: string;
}

export async function loadDeck(presentationId: string): Promise<Deck | null> {
  const { rows } = await query<{ title: string; workspace_id: string; ydoc: Buffer | null }>(
    'SELECT title, workspace_id, ydoc FROM presentations WHERE id = $1',
    [presentationId],
  );
  const row = rows[0];
  if (!row) return null;

  const live = liveDocument(slidesCollabName(presentationId));
  let throwaway: Y.Doc | null = null;
  let doc: Y.Doc;
  if (live) {
    doc = live;
  } else {
    throwaway = new Y.Doc();
    if (row.ydoc) Y.applyUpdate(throwaway, new Uint8Array(row.ydoc));
    doc = throwaway;
  }

  try {
    return { id: presentationId, title: row.title, workspaceId: row.workspace_id, ...readDeck(doc) };
  } finally {
    // Only a copy made here is destroyed; the live document belongs to the
    // people editing it.
    throwaway?.destroy();
  }
}
