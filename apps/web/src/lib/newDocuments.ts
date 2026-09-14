/**
 * Documents this session has just made.
 *
 * A document arrives called "Untitled", which is not a name but a prompt for
 * one, so the editor opens with the title selected and ready to be replaced.
 * Knowing which document that applies to is the only thing this holds.
 *
 * It is recorded where documents are created rather than passed down through
 * whatever opened it, because there are several ways to make one — the sidebar,
 * a folder, a canvas placing a card — and all of them go through the same
 * mutation. Claiming it consumes it, so coming back to the document later finds
 * an ordinary title that will not swallow itself when clicked.
 */
const fresh = new Set<string>();

export function rememberNewDocument(id: string): void {
  fresh.add(id);
}

/** True once, for a document made in this session and not yet opened. */
export function claimNewDocument(id: string): boolean {
  return fresh.delete(id);
}
