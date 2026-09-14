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
