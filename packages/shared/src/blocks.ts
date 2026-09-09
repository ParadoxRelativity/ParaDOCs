/**
 * BlockNote requires fully-formed blocks: every block needs a `props` object and
 * every inline text node needs `styles`, or constructing a document throws.
 *
 * Documents can be written by API clients that never ran BlockNote, so blocks
 * are normalized before the editor or the collaboration server touches them.
 * Shared so the browser and the server agree on what a block is.
 */

/**
 * Name of the Yjs XML fragment holding the document body. Pinned explicitly
 * rather than relying on BlockNote's default, so the browser and the
 * collaboration server can never disagree about where the content lives.
 */
export const COLLAB_FRAGMENT = 'document-store';

export function normalizeBlocks(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const blocks = input.map(normalizeBlock).filter((b): b is Record<string, unknown> => b !== null);
  return blocks.length > 0 ? blocks : undefined;
}

function normalizeBlock(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;

  return {
    id: typeof block.id === 'string' && block.id ? block.id : randomId(),
    type: typeof block.type === 'string' ? block.type : 'paragraph',
    props: isPlainObject(block.props) ? block.props : {},
    content: normalizeContent(block.content),
    children: Array.isArray(block.children)
      ? block.children.map(normalizeBlock).filter((b): b is Record<string, unknown> => b !== null)
      : [],
  };
}

function normalizeContent(content: unknown): unknown {
  if (content === undefined || content === null) return [];
  // Tables carry an object rather than an inline array; leave those to BlockNote.
  if (!Array.isArray(content)) return content;
  return content.map(normalizeInline);
}

function normalizeInline(raw: unknown): unknown {
  if (typeof raw === 'string') return { type: 'text', text: raw, styles: {} };
  if (!raw || typeof raw !== 'object') return { type: 'text', text: '', styles: {} };

  const node = raw as Record<string, unknown>;
  if (node.type === 'link') {
    return {
      type: 'link',
      href: typeof node.href === 'string' ? node.href : '',
      content: Array.isArray(node.content) ? node.content.map(normalizeInline) : [],
    };
  }
  if (node.type && node.type !== 'text') return node; // custom inline content

  return {
    type: 'text',
    text: typeof node.text === 'string' ? node.text : '',
    styles: isPlainObject(node.styles) ? node.styles : {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** crypto.randomUUID is available in browsers and in Node 19+. */
function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
