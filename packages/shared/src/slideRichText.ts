/**
 * The body of a rich text box, as plain data and as the Y.XmlFragment the
 * editor binds to.
 *
 * The fragment holds `paragraph` elements (attributes `align`, `bullet`,
 * `level`, `lineHeight`) made of text runs and `mention` elements (attributes
 * `userId`, `label`). A run's formatting is a Y.XmlText attribute per mark, in
 * the shape y-prosemirror reads and writes for the editor's schema: marks
 * without options are `{}`, the rest carry their option (`fontSize` is
 * `{ size }`, `color` is `{ color }`, ...). A bare number for `fontSize`, which
 * the outline writer used before the editor existed, is still understood.
 *
 * Everything that is not the editor (thumbnails, the slideshow, exports,
 * paste) works from the plain {@link RichParagraph} form.
 */

import * as Y from 'yjs';

export type RichAlign = 'left' | 'center' | 'right' | 'justify';
export type RichBullet = 'bullet' | 'number';

export interface RichMarks {
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  color?: string;
  highlight?: string;
  /** In slide units, like every size on a slide. */
  fontSize?: number;
  fontFamily?: string;
  link?: string;
}

export interface RichRun {
  text?: string;
  /** A tagged member, drawn as their current name; `label` is the name when they were tagged. */
  mention?: { userId: string; label: string };
  marks?: RichMarks;
}

export interface RichParagraph {
  align?: RichAlign;
  bullet?: RichBullet;
  /** Indent depth of a list item, from 0. */
  level?: number;
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
  runs: RichRun[];
}

export const RICH_ALIGNMENTS: RichAlign[] = ['left', 'center', 'right', 'justify'];
export const MAX_LIST_LEVEL = 5;
export const PARAGRAPH_NODE = 'paragraph';
export const MENTION_NODE = 'mention';

/** The Y.XmlText attributes that carry a run's formatting. */
export function marksToAttributes(marks: RichMarks | undefined): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (!marks) return attrs;
  if (marks.bold) attrs.bold = {};
  if (marks.italic) attrs.italic = {};
  if (marks.underline) attrs.underline = {};
  if (marks.strike) attrs.strike = {};
  if (marks.color) attrs.color = { color: marks.color };
  if (marks.highlight) attrs.highlight = { color: marks.highlight };
  if (typeof marks.fontSize === 'number') attrs.fontSize = { size: marks.fontSize };
  if (marks.fontFamily) attrs.fontFamily = { family: marks.fontFamily };
  if (marks.link) attrs.link = { href: marks.link };
  return attrs;
}

function optionOf(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** Marks from Y.XmlText attributes; anything unrecognised is dropped. */
export function attributesToMarks(attrs: Record<string, unknown> | undefined): RichMarks | undefined {
  if (!attrs) return undefined;
  const marks: RichMarks = {};
  for (const name of ['bold', 'italic', 'underline', 'strike'] as const) if (attrs[name] != null && attrs[name] !== false) marks[name] = true;
  const color = optionOf(attrs.color, 'color');
  if (typeof color === 'string') marks.color = color;
  const highlight = optionOf(attrs.highlight, 'color');
  if (typeof highlight === 'string') marks.highlight = highlight;
  const size = typeof attrs.fontSize === 'number' ? attrs.fontSize : Number(optionOf(attrs.fontSize, 'size'));
  if (Number.isFinite(size) && size > 0) marks.fontSize = size;
  const family = optionOf(attrs.fontFamily, 'family');
  if (typeof family === 'string') marks.fontFamily = family;
  const href = optionOf(attrs.link, 'href');
  if (typeof href === 'string') marks.link = href;
  return Object.keys(marks).length ? marks : undefined;
}

function levelOf(value: unknown): number | undefined {
  const level = Math.round(Number(value));
  return Number.isFinite(level) && level > 0 ? Math.min(level, MAX_LIST_LEVEL) : undefined;
}

/** A paragraph element as plain data. */
function readParagraph(node: Y.XmlElement): RichParagraph {
  const attrs = node.getAttributes() as Record<string, unknown>;
  const paragraph: RichParagraph = { runs: [] };
  if (RICH_ALIGNMENTS.includes(attrs.align as RichAlign) && attrs.align !== 'left') paragraph.align = attrs.align as RichAlign;
  if (attrs.bullet === 'bullet' || attrs.bullet === 'number') paragraph.bullet = attrs.bullet;
  const level = levelOf(attrs.level);
  if (level && paragraph.bullet) paragraph.level = level;
  const lineHeight = Number(attrs.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) paragraph.lineHeight = lineHeight;
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof op.insert !== 'string' || op.insert === '') continue;
        const marks = attributesToMarks(op.attributes);
        paragraph.runs.push(marks ? { text: op.insert, marks } : { text: op.insert });
      }
    } else if (child instanceof Y.XmlElement && child.nodeName === MENTION_NODE) {
      const userId = child.getAttribute('userId');
      if (typeof userId === 'string') paragraph.runs.push({ mention: { userId, label: String(child.getAttribute('label') ?? '') } });
    }
  }
  return paragraph;
}

/** A rich text body as plain data, one entry per paragraph. */
export function readParagraphs(fragment: Y.XmlFragment): RichParagraph[] {
  return fragment
    .toArray()
    .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
    .map(readParagraph);
}

/** Paragraphs as Y nodes ready to insert into a body (or into speaker notes). */
export function paragraphNodes(paragraphs: RichParagraph[]): Y.XmlElement[] {
  return paragraphs.map((paragraph) => {
    const node = new Y.XmlElement(PARAGRAPH_NODE);
    if (paragraph.align && paragraph.align !== 'left') node.setAttribute('align', paragraph.align);
    if (paragraph.bullet) {
      node.setAttribute('bullet', paragraph.bullet);
      if (paragraph.level) node.setAttribute('level', String(levelOf(paragraph.level) ?? 0));
    }
    if (paragraph.lineHeight) node.setAttribute('lineHeight', String(paragraph.lineHeight));
    const children: (Y.XmlText | Y.XmlElement)[] = [];
    let text: Y.XmlText | null = null;
    // Not integrated yet, so a text's runs are gathered and applied together.
    let delta: { insert: string; attributes?: Record<string, unknown> }[] = [];
    const flush = () => {
      if (text) text.applyDelta(delta);
      text = null;
      delta = [];
    };
    for (const run of paragraph.runs) {
      if (run.mention) {
        flush();
        const mention = new Y.XmlElement(MENTION_NODE);
        mention.setAttribute('userId', run.mention.userId);
        mention.setAttribute('label', run.mention.label);
        children.push(mention);
      } else if (run.text) {
        if (!text) {
          text = new Y.XmlText();
          children.push(text);
        }
        const attributes = marksToAttributes(run.marks);
        delta.push(Object.keys(attributes).length ? { insert: run.text, attributes } : { insert: run.text });
      }
    }
    flush();
    node.insert(0, children);
    return node;
  });
}

/** Replaces a body's content with the given paragraphs. */
export function writeParagraphs(fragment: Y.XmlFragment, paragraphs: RichParagraph[]): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length);
  fragment.insert(0, paragraphNodes(paragraphs.length ? paragraphs : [{ runs: [] }]));
}

/** Every member tagged in a body, once each. */
export function fragmentMentions(fragment: Y.XmlFragment): string[] {
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (node instanceof Y.XmlElement) {
      if (node.nodeName === MENTION_NODE) {
        const id = node.getAttribute('userId');
        if (typeof id === 'string') found.add(id);
      }
      node.toArray().forEach(visit);
    }
  };
  fragment.toArray().forEach(visit);
  return [...found];
}

/** The same body as plain text, a line per paragraph, a tag as `@name`. */
export function paragraphsText(paragraphs: RichParagraph[]): string {
  return paragraphs.map((p) => p.runs.map((run) => (run.mention ? `@${run.mention.label}` : (run.text ?? ''))).join('')).join('\n');
}

/**
 * Paragraphs of plain text, a paragraph per line: what pasting or typing text
 * from elsewhere makes. Lines that start like a list item become one.
 */
export function plainTextParagraphs(text: string): RichParagraph[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
      if (bullet) return { bullet: 'bullet' as const, level: Math.min(Math.floor(bullet[1].replace(/\t/g, '  ').length / 2), MAX_LIST_LEVEL), runs: [{ text: bullet[2] }] };
      return { runs: line ? [{ text: line }] : [] };
    });
}

/**
 * The number each numbered paragraph shows: it counts up through consecutive
 * numbered paragraphs of the same level, and starts over after anything that
 * is not a deeper item of the list. Unnumbered paragraphs get null.
 */
export function listNumbers(paragraphs: Pick<RichParagraph, 'bullet' | 'level'>[]): (number | null)[] {
  const counters: number[] = [];
  return paragraphs.map((p) => {
    if (p.bullet !== 'number') {
      counters.length = 0;
      return null;
    }
    const level = p.level ?? 0;
    counters.length = level + 1;
    counters[level] = (counters[level] ?? 0) + 1;
    return counters[level];
  });
}
