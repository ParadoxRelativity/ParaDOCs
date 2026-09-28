import type * as Y from 'yjs';

/**
 * The collaboration server's open documents, for code outside it.
 *
 * A spreadsheet someone is editing is newer in memory than in the database by
 * up to the save debounce. Anything asked for "the latest value" should read
 * the one in memory when there is one, and this is how the REST side reaches
 * it without importing the collaboration server itself.
 */
type Lookup = (name: string) => Y.Doc | undefined;

let lookup: Lookup = () => undefined;

export function setLiveDocumentLookup(next: Lookup): void {
  lookup = next;
}

export function liveDocument(name: string): Y.Doc | undefined {
  return lookup(name);
}

/**
 * Changes a document through the collaboration server, as `userId`. The
 * change reaches everyone with it open and is saved the way their own edits
 * are; a change made to the open Y.Doc directly would reach them but never be
 * saved, since the server only stores what arrives over a connection.
 */
type Editor = (name: string, userId: string, change: (doc: Y.Doc) => void) => Promise<void>;

let editor: Editor | null = null;

export function setLiveDocumentEditor(next: Editor): void {
  editor = next;
}

/** False when there is no collaboration server in this process to go through. */
export async function editLiveDocument(name: string, userId: string, change: (doc: Y.Doc) => void): Promise<boolean> {
  if (!editor) return false;
  await editor(name, userId, change);
  return true;
}
