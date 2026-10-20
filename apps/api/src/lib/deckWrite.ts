import * as Y from 'yjs';
import { deckSearchText, readDeck, slidesCollabName } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { editLiveDocument } from './liveDocuments.js';

/**
 * Changes a presentation's slides from outside the editor, as `userId`, for
 * the assistant tools. The caller has already checked the person may edit it.
 *
 * Through the collaboration server when there is one, so anyone with the deck
 * open sees the change as it lands and it is saved the way their own edits
 * are. Without one (a desktop workspace running no socket) the saved copy is
 * changed directly and its search text rederived, as the server does on save.
 */
export async function editDeck(userId: string, presentationId: string, change: (doc: Y.Doc) => void): Promise<void> {
  if (await editLiveDocument(slidesCollabName(presentationId), userId, change)) return;

  const { rows } = await query<{ ydoc: Buffer | null }>('SELECT ydoc FROM presentations WHERE id = $1', [presentationId]);
  if (!rows[0]) throw new Error('Presentation not found');
  const doc = new Y.Doc();
  try {
    if (rows[0].ydoc) Y.applyUpdate(doc, new Uint8Array(rows[0].ydoc));
    doc.transact(() => change(doc));
    await query(
      `UPDATE presentations
          SET ydoc = $2, search_text = $3, last_edited_by = $4, updated_at = now()
        WHERE id = $1`,
      [presentationId, Buffer.from(Y.encodeStateAsUpdate(doc)), deckSearchText(readDeck(doc).slides), userId],
    );
  } finally {
    doc.destroy();
  }
}
