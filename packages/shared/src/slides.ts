/**
 * Slides data model.
 *
 * A presentation is one Y.Doc, the live truth while anyone has it open and
 * saved to presentations.ydoc. Its layout is defined here, once, so the editor,
 * presenter, importers, exporters, search and assistant tools all read the same
 * structure:
 *
 *   deck            Y.Map    slide size, theme id, footer/number/date toggles
 *   slideOrder      Y.Array  slide ids, in running order
 *   slide:<id>      Y.Map    layoutId, background, hidden, transition, and
 *                            `elements`: a Y.Map of element id -> Y.Map
 *   notes:<id>      Y.XmlFragment  the speaker notes of a slide
 *   themes          Y.Map    theme id -> Theme
 *   layouts         Y.Map    layout id -> SlideLayout
 *   master          Y.Map    the slide master, one key per field (slideTheme.ts)
 *
 * Order is kept apart from content so reordering never conflicts with editing,
 * and every element is its own Y.Map so two people editing different elements,
 * or different properties of one, merge instead of clobbering a blob.
 *
 * Coordinates are logical units on a fixed-size slide (1920x1080 by default),
 * scaled to fit wherever the slide is drawn.
 */

import * as Y from 'yjs';
import { z } from 'zod';
import type {
  AudioElement,
  CanvasElementBase,
  ConnectorElement,
  EmbedElement,
  ImageElement,
  LinkElement,
  ShapeElement,
  SheetCellElement,
  SheetChartElement,
  TextElement,
  VideoElement,
  WorkItemElement,
} from './canvas.js';
import type { ElementAnimation } from './slideBuilds.js';
import type { AccessMode, Permission } from './types.js';
import {
  MENTION_NODE,
  fragmentMentions,
  readParagraphs,
  writeParagraphs,
  type RichAlign,
  type RichParagraph,
} from './slideRichText.js';
import type { SlideShapeKind } from './slideShapes.js';
import {
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  BLANK_LAYOUT_ID,
  defaultLayouts,
  defaultMaster,
  normalizeTheme,
  resolveSlide,
  type SlideBackground,
  type SlideFrame,
  type PlaceholderKind,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from './slideTheme.js';

export * from './slideRichText.js';
export * from './slideShapes.js';
export * from './slideFonts.js';
export * from './slideFromCanvas.js';
export * from './slideTheme.js';

/**
 * The collaboration server serves documents, spreadsheets and presentations
 * over one socket, and tells them apart by a prefix on the name.
 */
export const SLIDES_COLLAB_PREFIX = 'slides:';

export function slidesCollabName(id: string): string {
  return `${SLIDES_COLLAB_PREFIX}${id}`;
}

/** The presentation a collaboration name refers to, or null for anything else. */
export function presentationIdFromCollabName(name: string): string | null {
  return name.startsWith(SLIDES_COLLAB_PREFIX) ? name.slice(SLIDES_COLLAB_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// Slide size
// ---------------------------------------------------------------------------

export interface SlideSize {
  width: number;
  height: number;
}

export const SLIDE_SIZE_16_9: SlideSize = { width: 1920, height: 1080 };
export const SLIDE_SIZE_4_3: SlideSize = { width: 1440, height: 1080 };
export const DEFAULT_SLIDE_SIZE: SlideSize = SLIDE_SIZE_16_9;
export const MIN_SLIDE_DIMENSION = 160;
export const MAX_SLIDE_DIMENSION = 10_000;

export const slideSizeSchema = z.object({
  width: z.number().int().min(MIN_SLIDE_DIMENSION).max(MAX_SLIDE_DIMENSION),
  height: z.number().int().min(MIN_SLIDE_DIMENSION).max(MAX_SLIDE_DIMENSION),
});

/** A size read from a Y.Doc or an import: whole numbers in range, else the default. */
export function normalizeSlideSize(size: Partial<SlideSize> | null | undefined): SlideSize {
  const parsed = slideSizeSchema.safeParse({ width: Math.round(Number(size?.width)), height: Math.round(Number(size?.height)) });
  return parsed.success ? parsed.data : { ...DEFAULT_SLIDE_SIZE };
}

export function slideAspectRatio(size: SlideSize): number {
  return size.width / size.height;
}

/** The scale that fits a slide inside a box without cropping it. */
export function fitScale(size: SlideSize, boxWidth: number, boxHeight: number): number {
  return Math.min(boxWidth / size.width, boxHeight / size.height);
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

export const SLIDE_TRANSITION_KINDS = ['none', 'fade', 'push', 'wipe', 'zoom'] as const;
export type SlideTransitionKind = (typeof SLIDE_TRANSITION_KINDS)[number];

export interface SlideTransition {
  kind: SlideTransitionKind;
  durationMs?: number;
}

export const slideTransitionSchema = z.object({
  kind: z.enum(SLIDE_TRANSITION_KINDS),
  durationMs: z.number().int().min(0).max(10_000).optional(),
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** What every slide element carries: the canvas base (x, y, width, height, z, color) plus rotation in degrees. */
export interface SlideElementBase extends Omit<CanvasElementBase, 'type'> {
  rotation?: number;
  /** How it builds in or out during the slideshow; see slideBuilds.ts. */
  animation?: ElementAnimation;
}

type OnSlide<T extends CanvasElementBase> = T & { rotation?: number; animation?: ElementAnimation };

/** A shape on a slide: the canvas shape's fill and outline, more outlines to choose from, a shadow, and sized text. */
export type SlideShapeElement = Omit<ShapeElement, 'shape'> & {
  shape: SlideShapeKind;
  shadow?: boolean;
  /** Size of the text inside, in slide units. */
  fontSize?: number;
};

/** A picture: shown filling its box (`cover`) or whole (`contain`), optionally cropped to a part of it. */
export type SlideImageElement = ImageElement & {
  fit?: 'cover' | 'contain';
  /** The part of the picture shown, as fractions of its width and height. */
  crop?: { x: number; y: number; width: number; height: number };
  opacity?: number;
  /** A layout placeholder this picture fills (an empty `url` is a placeholder waiting for one). */
  placeholder?: string;
  placeholderKind?: PlaceholderKind;
  prompt?: string;
};

/** Canvas element types that mean the same on a slide as on a board. */
export type SlideCanvasElement =
  | OnSlide<TextElement>
  | OnSlide<SlideShapeElement>
  | OnSlide<SlideImageElement>
  | OnSlide<AudioElement>
  | OnSlide<VideoElement>
  | OnSlide<EmbedElement>
  | OnSlide<SheetCellElement>
  | OnSlide<SheetChartElement>
  | OnSlide<WorkItemElement>
  | OnSlide<LinkElement>
  | OnSlide<ConnectorElement>;

export type RichTextVerticalAlign = 'top' | 'middle' | 'bottom';

/**
 * A formatted text box. The text itself is a Y.XmlFragment stored under `body`
 * in the element's Y.Map (see slideRichText.ts for its shape). Snapshots carry
 * its plain digest as `text` and its content as `paragraphs`; neither is
 * written from a snapshot except to give a new box its first content, so a
 * paste or an import fills a body and every later change goes through the
 * editor.
 */
export interface RichTextElement extends SlideElementBase {
  type: 'richText';
  /**
   * A placeholder this box fills, by id, in the slide's layout. Position and
   * text style it does not set itself come from that placeholder.
   */
  placeholder?: string;
  /** Derived when a deck is read: the kind of that placeholder, and what it says while empty. */
  placeholderKind?: PlaceholderKind;
  prompt?: string;
  bold?: boolean;
  italic?: boolean;
  /** Plain digest of the body, filled in when a slide is read. */
  text?: string;
  /** The body as data, filled in when a slide is read, and read to give a new box its content. */
  paragraphs?: RichParagraph[];
  /** Size of text that has no size of its own, in slide units. Default 32. */
  fontSize?: number;
  /** Font of text that has none of its own; the theme's body font when absent. */
  fontFamily?: string;
  align?: RichAlign;
  verticalAlign?: RichTextVerticalAlign;
  /** Line height of paragraphs that set none, as a multiple of the font size. Default 1.2. */
  lineSpacing?: number;
  /** Shrink the text when it overflows the box. On unless set to false. */
  autofit?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface TableCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  /** In slide units; the table's own size when absent. */
  fontSize?: number;
  fill?: string;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: RichTextVerticalAlign;
  /** Overrides the table's cell border for this cell; a width of 0 draws none. */
  borderColor?: string;
  borderWidth?: number;
  /** On the top-left cell of a merged range: how many columns and rows it spans. */
  colSpan?: number;
  rowSpan?: number;
}

/** Cells are keyed by `tableCellKey(row, column)`; empty cells are simply absent. */
export interface TableElement extends SlideElementBase {
  type: 'table';
  rows: number;
  columns: number;
  columnWidths?: number[];
  rowHeights?: number[];
  cells: Record<string, TableCell>;
  /** Text size for cells that set none. Default 28. */
  fontSize?: number;
  fontFamily?: string;
  borderColor?: string;
  /** Border width in slide units; 0 draws none. Default 2. */
  borderWidth?: number;
  /** The first row is bold and shaded. */
  headerRow?: boolean;
}

export type SlideElement = SlideCanvasElement | RichTextElement | TableElement;
export type SlideElementType = SlideElement['type'];

export function tableCellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

// ---------------------------------------------------------------------------
// Y.Doc layout
// ---------------------------------------------------------------------------

export const DECK_MAP = 'deck';
export const SLIDE_ORDER = 'slideOrder';
export const THEMES_MAP = 'themes';
export const LAYOUTS_MAP = 'layouts';
export const MASTER_MAP = 'master';
export const SLIDE_ELEMENTS_KEY = 'elements';
export const ELEMENT_BODY_KEY = 'body';

export function slideMapName(slideId: string): string {
  return `slide:${slideId}`;
}

export function notesFragmentName(slideId: string): string {
  return `notes:${slideId}`;
}

export interface DeckSettings {
  size: SlideSize;
  themeId: string;
  showFooter: boolean;
  showSlideNumber: boolean;
  showDate: boolean;
  footerText: string;
  /** Text shown for the date when it is on; empty shows today's date. */
  dateText: string;
}

export interface SlideSnapshot {
  id: string;
  layoutId: string;
  background: SlideBackground | null;
  hidden: boolean;
  transition: SlideTransition;
  elements: SlideElement[];
  /** Speaker notes as plain text, paragraphs separated by newlines. */
  notes: string;
  /** Derived when a deck is read: the page behind the elements and the footer; see resolveSlide. */
  frame?: SlideFrame;
}

export interface DeckSnapshot {
  settings: DeckSettings;
  slides: SlideSnapshot[];
  themes: Theme[];
  layouts: SlideLayout[];
  master: SlideMaster;
}

/** A Y type read as plain JSON, so snapshots carry no Y types. */
function plain<T>(value: unknown): T {
  return (value instanceof Y.AbstractType ? value.toJSON() : value) as T;
}

export function readDeckSettings(doc: Y.Doc): DeckSettings {
  const deck = doc.getMap<unknown>(DECK_MAP);
  return {
    size: normalizeSlideSize({ width: deck.get('width') as number, height: deck.get('height') as number }),
    themeId: typeof deck.get('themeId') === 'string' ? (deck.get('themeId') as string) : DEFAULT_THEME_ID,
    showFooter: deck.get('showFooter') === true,
    showSlideNumber: deck.get('showSlideNumber') === true,
    showDate: deck.get('showDate') === true,
    footerText: typeof deck.get('footerText') === 'string' ? (deck.get('footerText') as string) : '',
    dateText: typeof deck.get('dateText') === 'string' ? (deck.get('dateText') as string) : '',
  };
}

/** Writes the given settings, leaving the rest as they were. */
export function writeDeckSettings(doc: Y.Doc, settings: Partial<DeckSettings>): void {
  doc.transact(() => {
    const deck = doc.getMap<unknown>(DECK_MAP);
    if (settings.size) {
      const size = normalizeSlideSize(settings.size);
      deck.set('width', size.width);
      deck.set('height', size.height);
    }
    for (const key of ['themeId', 'showFooter', 'showSlideNumber', 'showDate', 'footerText', 'dateText'] as const) {
      if (settings[key] !== undefined) deck.set(key, settings[key]);
    }
  });
}

/**
 * Slide ids in running order. Two people adding a slide at once can leave the
 * same id twice; it is listed once.
 */
export function readSlideOrder(doc: Y.Doc): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of doc.getArray<string>(SLIDE_ORDER).toArray()) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function elementsOf(doc: Y.Doc, slideId: string): Y.Map<Y.Map<unknown>> | null {
  const elements = doc.getMap<unknown>(slideMapName(slideId)).get(SLIDE_ELEMENTS_KEY);
  return elements instanceof Y.Map ? (elements as Y.Map<Y.Map<unknown>>) : null;
}

export interface NewSlide {
  id?: string;
  layoutId?: string;
  background?: SlideBackground;
  hidden?: boolean;
  transition?: SlideTransition;
  /** Position in the running order; the end when left out. */
  index?: number;
}

/** Adds a slide, creating its elements map in the same transaction so nobody else ever has to. */
export function createSlide(doc: Y.Doc, slide: NewSlide = {}): string {
  const id = slide.id ?? crypto.randomUUID();
  doc.transact(() => {
    const map = doc.getMap<unknown>(slideMapName(id));
    map.set('layoutId', slide.layoutId ?? BLANK_LAYOUT_ID);
    map.set('hidden', slide.hidden ?? false);
    map.set('transition', slide.transition ?? { kind: 'none' });
    if (slide.background) map.set('background', slide.background);
    if (!(map.get(SLIDE_ELEMENTS_KEY) instanceof Y.Map)) map.set(SLIDE_ELEMENTS_KEY, new Y.Map());
    const order = doc.getArray<string>(SLIDE_ORDER);
    order.insert(Math.min(Math.max(slide.index ?? order.length, 0), order.length), [id]);
  });
  return id;
}

/** Removes a slide from the order and empties what is stored under its name; root types cannot be deleted. */
export function deleteSlide(doc: Y.Doc, slideId: string): void {
  doc.transact(() => {
    const order = doc.getArray<string>(SLIDE_ORDER);
    for (let i = order.length - 1; i >= 0; i--) if (order.get(i) === slideId) order.delete(i, 1);
    doc.getMap<unknown>(slideMapName(slideId)).clear();
    const notes = doc.getXmlFragment(notesFragmentName(slideId));
    notes.delete(0, notes.length);
  });
}

/** Moves a slide to `toIndex` in the running order, counted as it will be after the move. */
export function moveSlide(doc: Y.Doc, slideId: string, toIndex: number): void {
  doc.transact(() => {
    const order = doc.getArray<string>(SLIDE_ORDER);
    const from = order.toArray().indexOf(slideId);
    if (from < 0) return;
    order.delete(from, 1);
    order.insert(Math.min(Math.max(toIndex, 0), order.length), [slideId]);
  });
}

/** Puts an element on a slide, writing each property as its own key so edits merge per property. */
export function setSlideElement(doc: Y.Doc, slideId: string, element: SlideElement): void {
  doc.transact(() => {
    const elements = elementsOf(doc, slideId);
    if (!elements) return;
    let map = elements.get(element.id);
    if (!map) {
      map = new Y.Map();
      elements.set(element.id, map);
    }
    for (const [key, value] of Object.entries(element)) {
      // The body of a rich text box is a Y.XmlFragment the editor owns, and its
      // digest is derived, so neither is written from a snapshot.
      if (value === undefined || (element.type === 'richText' && (key === 'text' || key === 'paragraphs' || key === ELEMENT_BODY_KEY))) continue;
      // Derived from the placeholder's layout when a deck is read, never stored.
      if (key === 'placeholderKind' || key === 'prompt') continue;
      if (element.type === 'table' && key === 'cells') {
        let cells = map.get('cells') as Y.Map<TableCell> | undefined;
        if (!(cells instanceof Y.Map)) {
          cells = new Y.Map<TableCell>();
          map.set('cells', cells);
        }
        for (const [cellKey, cell] of Object.entries(value as Record<string, TableCell>)) cells.set(cellKey, cell);
        continue;
      }
      map.set(key, value);
    }
    if (element.type === 'richText' && !(map.get(ELEMENT_BODY_KEY) instanceof Y.XmlFragment)) {
      map.set(ELEMENT_BODY_KEY, new Y.XmlFragment());
      // Only a new box takes content from a snapshot (a paste, an import); an existing body belongs to its editors.
      const body = map.get(ELEMENT_BODY_KEY) as Y.XmlFragment;
      if (element.paragraphs?.length) writeParagraphs(body, element.paragraphs);
    }
  });
}

export function removeSlideElement(doc: Y.Doc, slideId: string, elementId: string): void {
  elementsOf(doc, slideId)?.delete(elementId);
}

/** Text of a Y.XmlFragment: one line per paragraph, runs joined, formatting dropped. */
export function fragmentText(fragment: Y.XmlFragment): string {
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string => {
    if (node instanceof Y.XmlText) {
      return (node.toDelta() as { insert?: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
    }
    if (node instanceof Y.XmlElement && node.nodeName === MENTION_NODE) return `@${node.getAttribute('label') ?? ''}`;
    // BlockNote nests a line per block inside group and container nodes (speaker notes are written with it); runs inside a block join.
    const blocks = node instanceof Y.XmlElement && (node.nodeName === 'blockGroup' || node.nodeName === 'blockContainer');
    return node
      .toArray()
      .map((child) => visit(child as Y.XmlElement | Y.XmlText))
      .join(blocks ? '\n' : '');
  };
  return fragment
    .toArray()
    .map((child) => visit(child as Y.XmlElement | Y.XmlText))
    .join('\n');
}

function readElement(value: Y.Map<unknown>): SlideElement | null {
  const json: Record<string, unknown> = {};
  value.forEach((entry, key) => {
    if (key === ELEMENT_BODY_KEY && entry instanceof Y.XmlFragment) {
      json.text = fragmentText(entry);
      json.paragraphs = readParagraphs(entry);
    } else json[key] = plain(entry);
  });
  if (typeof json.id !== 'string' || typeof json.type !== 'string') return null;
  return json as unknown as SlideElement;
}

export function readSlide(doc: Y.Doc, slideId: string): SlideSnapshot {
  const map = doc.getMap<unknown>(slideMapName(slideId));
  const elements: SlideElement[] = [];
  elementsOf(doc, slideId)?.forEach((value) => {
    const element = value instanceof Y.Map ? readElement(value) : null;
    if (element) elements.push(element);
  });
  elements.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id));
  const transition = plain<SlideTransition | undefined>(map.get('transition'));
  return {
    id: slideId,
    layoutId: typeof map.get('layoutId') === 'string' ? (map.get('layoutId') as string) : BLANK_LAYOUT_ID,
    background: plain<SlideBackground | undefined>(map.get('background')) ?? null,
    hidden: map.get('hidden') === true,
    transition: transition && SLIDE_TRANSITION_KINDS.includes(transition.kind) ? transition : { kind: 'none' },
    elements,
    notes: fragmentText(doc.getXmlFragment(notesFragmentName(slideId))),
  };
}

function readCollection<T extends { id: string }>(doc: Y.Doc, name: string): T[] {
  const items: T[] = [];
  doc.getMap<unknown>(name).forEach((value) => {
    const item = plain<T>(value);
    if (item && typeof item.id === 'string') items.push(item);
  });
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The whole deck as plain data. An id in the order with no slide behind it is
 * skipped. A deck nobody has edited yet reads with the default theme and layouts.
 */
export function readDeck(doc: Y.Doc): DeckSnapshot {
  const settings = readDeckSettings(doc);
  const themes = readCollection<Theme>(doc, THEMES_MAP).map(normalizeTheme);
  const stored = readCollection<SlideLayout>(doc, LAYOUTS_MAP);
  const layouts = stored.length ? stored : defaultLayouts(settings.size);
  const master = readMaster(doc, settings.size);
  const today = new Date().toLocaleDateString();
  const order = readSlideOrder(doc).filter((id) => elementsOf(doc, id));
  return {
    settings,
    slides: order.map((id, i) => resolveSlide(readSlide(doc, id), { layouts, master, settings, number: i + 1, today })),
    themes: themes.length ? themes : [DEFAULT_THEME],
    layouts,
    master,
  };
}

/** The deck's master: each field as stored, else the default for the slide size. */
export function readMaster(doc: Y.Doc, size: SlideSize = DEFAULT_SLIDE_SIZE): SlideMaster {
  const stored = doc.getMap<unknown>(MASTER_MAP);
  const fallback = defaultMaster(size);
  const field = <K extends keyof SlideMaster>(key: K): SlideMaster[K] => (stored.has(key) ? plain<SlideMaster[K]>(stored.get(key)) : fallback[key]);
  return { id: field('id'), name: field('name'), background: field('background'), placeholders: field('placeholders'), elements: field('elements') };
}

const TEXT_TAG = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/**
 * Who is tagged on which slide: in a rich text box (a mention in its body) or
 * in a shape's or text box's plain text (an `<@id>` token, as on a canvas).
 * Each person is listed once, with the first slide that names them.
 */
export function deckMentions(doc: Y.Doc): { userId: string; slideId: string }[] {
  const found = new Map<string, string>();
  for (const slideId of readSlideOrder(doc)) {
    elementsOf(doc, slideId)?.forEach((element) => {
      if (!(element instanceof Y.Map)) return;
      const body = element.get(ELEMENT_BODY_KEY);
      const ids = body instanceof Y.XmlFragment ? fragmentMentions(body) : [];
      const text = element.get('text');
      if (typeof text === 'string' && text.includes('<@')) for (const match of text.matchAll(TEXT_TAG)) ids.push(match[1].toLowerCase());
      for (const id of ids) if (!found.has(id)) found.set(id, slideId);
    });
  }
  return [...found].map(([userId, slideId]) => ({ userId, slideId }));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** What an element says, as text. Empty for elements that only show something. */
export function slideElementText(element: SlideElement): string {
  switch (element.type) {
    case 'text':
      return element.text;
    case 'shape':
      return element.text ?? '';
    case 'richText':
      return element.text ?? '';
    case 'image':
      return element.alt ?? '';
    case 'video':
    case 'embed':
      return element.title ?? '';
    case 'sheetCell':
    case 'sheetChart':
    case 'workItem':
      return element.label ?? '';
    case 'link':
      return element.title ?? '';
    case 'table':
      return Object.keys(element.cells)
        .sort((a, b) => {
          const [ar, ac] = a.split(':').map(Number);
          const [br, bc] = b.split(':').map(Number);
          return ar - br || ac - bc;
        })
        .map((key) => element.cells[key].text)
        .filter(Boolean)
        .join('\n');
    default:
      return '';
  }
}

/** The text of a deck for search: each slide's text then its notes, slides separated by a blank line. */
export function deckSearchText(slides: Pick<SlideSnapshot, 'elements' | 'notes'>[]): string {
  return slides
    .map((slide) =>
      [...slide.elements.map(slideElementText), slide.notes]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n');
}

/** A presentation as a list shows it. */
export interface PresentationSummary {
  id: string;
  workspaceId: string;
  /** The Slides folder it is filed in, or null for none. */
  folderId: string | null;
  title: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Its own setting; see AccessMode. */
  access: AccessMode;
  /** What the signed-in person may do with it: `view` or `edit`. */
  permission: Permission;
}
