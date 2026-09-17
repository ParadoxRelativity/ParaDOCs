/**
 * Tagging people in documents and on canvases.
 *
 * The two surfaces store a tag differently because they store text differently,
 * and each uses whatever its own format already does for references:
 *
 * - A document's body is BlockNote content, which already writes a channel
 *   reference as an ordinary link. A person is written the same way, as a link
 *   to `/w/<workspace>/u/<user>` carrying their name, so the server's BlockNote
 *   schema round-trips it untouched and the markdown derived for search reads
 *   `[@Ada Lovelace](/w/…/u/…)`.
 *
 * - A canvas element's text is a plain string, so a tag is the same `<@uuid>`
 *   token chat uses. Nothing there caches a name, which is why a canvas tag
 *   follows a rename and a document one does not.
 *
 * What both have in common is the only thing the server needs: the ids of the
 * people tagged, so it can tell them.
 */

import { parseMessage } from './chat.js';
import type { CanvasElement } from './canvas.js';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Where a tag in a document points. Not a page: the client opens a conversation. */
const MENTION_HREF = new RegExp(`^/w/(${UUID})/u/(${UUID})$`, 'i');

export function mentionHref(workspaceId: string, userId: string): string {
  return `/w/${workspaceId}/u/${userId}`;
}

/** The person a document link names, or null when the link is an ordinary one. */
export function parseMentionHref(href: string): { workspaceId: string; userId: string } | null {
  const match = MENTION_HREF.exec(href.trim());
  return match ? { workspaceId: match[1].toLowerCase(), userId: match[2].toLowerCase() } : null;
}

/** How a tag reads in a document before anyone renames themselves. */
export function mentionLabel(name: string): string {
  return `@${name}`;
}

// --- finding the people tagged ----------------------------------------------

interface InlineNode {
  type?: string;
  href?: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

interface BlockNode {
  content?: unknown;
  children?: unknown;
}

/**
 * Visits every inline node in a document body — including those inside table
 * cells, links and nested blocks — so each kind of reference can be found by
 * walking the blocks rather than the derived markdown, which is lossy by design.
 */
export function walkInlineNodes(blocks: unknown, visit: (node: InlineNode) => void): void {
  const walkInline = (content: unknown): void => {
    if (!Array.isArray(content)) {
      // A table carries its rows in an object rather than an inline array.
      const rows = (content as { rows?: { cells?: unknown[] }[] } | undefined)?.rows;
      if (Array.isArray(rows)) for (const row of rows) for (const cell of row.cells ?? []) walkInline(cell);
      return;
    }
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const node = raw as InlineNode;
      visit(node);
      if (node.content) walkInline(node.content);
    }
  };

  const walkBlocks = (input: unknown): void => {
    if (!Array.isArray(input)) return;
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as BlockNode;
      walkInline(block.content);
      walkBlocks(block.children);
    }
  };

  walkBlocks(blocks);
}

/** Every person tagged in a document body. */
export function blockMentions(blocks: unknown): string[] {
  const found = new Set<string>();
  walkInlineNodes(blocks, (node) => {
    if (node.type !== 'link' || typeof node.href !== 'string') return;
    const mention = parseMentionHref(node.href);
    if (mention) found.add(mention.userId);
  });
  return [...found];
}

/** Every text field a canvas element can hold a tag in. */
export function canvasTextOf(element: CanvasElement): string[] {
  switch (element.type) {
    case 'note':
    case 'text':
    case 'node':
      return [element.text];
    case 'shape':
      return [element.text ?? ''];
    case 'frame':
      return [element.name];
    case 'connector':
      return [element.label ?? ''];
    default:
      return [];
  }
}

/** Every person tagged anywhere on a canvas. */
export function canvasMentions(elements: CanvasElement[]): string[] {
  const found = new Set<string>();
  for (const element of elements) {
    for (const text of canvasTextOf(element)) {
      if (!text.includes('<@')) continue;
      for (const segment of parseMessage(text)) {
        if (segment.type === 'member') found.add(segment.id);
      }
    }
  }
  return [...found];
}

/**
 * A canvas tag as a reader would say it, for search and for previews. Names
 * come from the caller because the canvas itself stores only ids; without them
 * a tag is dropped rather than indexed as a bare uuid nobody will ever search
 * for.
 */
export function renderCanvasMentions(text: string, names: Map<string, string>): string {
  if (!text.includes('<@')) return text;
  return parseMessage(text)
    .map((segment) => {
      if (segment.type === 'text') return segment.value;
      if (segment.type !== 'member') return '';
      const name = names.get(segment.id);
      return name ? `@${name}` : '';
    })
    .join('');
}
