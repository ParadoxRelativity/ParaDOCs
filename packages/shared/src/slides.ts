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
  CanvasElementBase,
  ConnectorElement,
  EmbedElement,
  ImageElement,
  ShapeElement,
  SheetCellElement,
  SheetChartElement,
  TextElement,
  VideoElement,
  WorkItemElement,
} from './canvas.js';
import type { AccessMode, Permission } from './types.js';

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
// Themes and layouts
// ---------------------------------------------------------------------------

export const THEME_COLOR_SLOTS = [
  'dark1',
  'light1',
  'dark2',
  'light2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hyperlink',
] as const;
export type ThemeColorSlot = (typeof THEME_COLOR_SLOTS)[number];

export interface Theme {
  id: string;
  name: string;
  colors: Record<ThemeColorSlot, string>;
  fonts: { heading: string; body: string };
}

export const DEFAULT_THEME_ID = 'default';

export const DEFAULT_THEME: Theme = {
  id: DEFAULT_THEME_ID,
  name: 'Default',
  colors: {
    dark1: '#111827',
    light1: '#ffffff',
    dark2: '#374151',
    light2: '#f3f4f6',
    accent1: '#2563eb',
    accent2: '#dc2626',
    accent3: '#16a34a',
    accent4: '#d97706',
    accent5: '#7c3aed',
    accent6: '#0891b2',
    hyperlink: '#2563eb',
  },
  fonts: { heading: 'Inter', body: 'Inter' },
};

const THEME_COLOR_PREFIX = 'theme:';

/** How an element names a theme color slot in a color field, so a theme change restyles it. */
export function themeColor(slot: ThemeColorSlot): string {
  return `${THEME_COLOR_PREFIX}${slot}`;
}

export function themeSlotOf(value: string | undefined): ThemeColorSlot | null {
  if (!value?.startsWith(THEME_COLOR_PREFIX)) return null;
  const slot = value.slice(THEME_COLOR_PREFIX.length) as ThemeColorSlot;
  return (THEME_COLOR_SLOTS as readonly string[]).includes(slot) ? slot : null;
}

/** A color field as a concrete color: a slot is looked up in the theme, anything else passes through. */
export function resolveSlideColor(value: string | undefined, theme: Theme): string | undefined {
  if (value === undefined) return undefined;
  const slot = themeSlotOf(value);
  return slot ? theme.colors[slot] : value;
}

export type PlaceholderKind = 'title' | 'subtitle' | 'body' | 'image' | 'footer' | 'slideNumber' | 'date';

export interface LayoutPlaceholder {
  id: string;
  kind: PlaceholderKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlideLayout {
  id: string;
  name: string;
  placeholders: LayoutPlaceholder[];
}

export const BLANK_LAYOUT_ID = 'blank';

export const DEFAULT_LAYOUTS: SlideLayout[] = [
  { id: BLANK_LAYOUT_ID, name: 'Blank', placeholders: [] },
  {
    id: 'title',
    name: 'Title',
    placeholders: [
      { id: 'title', kind: 'title', x: 160, y: 340, width: 1600, height: 220 },
      { id: 'subtitle', kind: 'subtitle', x: 160, y: 580, width: 1600, height: 120 },
    ],
  },
  {
    id: 'titleAndContent',
    name: 'Title and content',
    placeholders: [
      { id: 'title', kind: 'title', x: 120, y: 80, width: 1680, height: 140 },
      { id: 'body', kind: 'body', x: 120, y: 260, width: 1680, height: 720 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

export type SlideBackground = { kind: 'color'; color: string } | { kind: 'image'; url: string };

export const SLIDE_TRANSITION_KINDS = ['none', 'fade', 'push', 'zoom'] as const;
export type SlideTransitionKind = (typeof SLIDE_TRANSITION_KINDS)[number];

export interface SlideTransition {
  kind: SlideTransitionKind;
  durationMs?: number;
}

export const slideBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color: z.string().max(64) }),
  z.object({ kind: z.literal('image'), url: z.string().max(2000) }),
]);

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
}

type OnSlide<T extends CanvasElementBase> = T & { rotation?: number };

/** Canvas element types that mean the same on a slide as on a board. */
export type SlideCanvasElement =
  | OnSlide<TextElement>
  | OnSlide<ShapeElement>
  | OnSlide<ImageElement>
  | OnSlide<VideoElement>
  | OnSlide<EmbedElement>
  | OnSlide<SheetCellElement>
  | OnSlide<SheetChartElement>
  | OnSlide<WorkItemElement>
  | OnSlide<ConnectorElement>;

export type RichTextBullet = 'none' | 'bullet' | 'number';

/**
 * A formatted text box. The text itself is a Y.XmlFragment stored under `body`
 * in the element's Y.Map: `paragraph` nodes (attributes `align`, `bullet`,
 * `level`) holding text runs with marks (bold, italic, underline, strike,
 * color, fontSize, fontFamily, link). Snapshots carry only `text`, its plain
 * digest.
 */
export interface RichTextElement extends SlideElementBase {
  type: 'richText';
  /** A placeholder this box fills, by id, in the slide's layout. */
  placeholder?: string;
  /** Plain digest of the body, filled in when a slide is read. */
  text?: string;
}

export interface TableCell {
  text: string;
  bold?: boolean;
  fill?: string;
  align?: 'left' | 'center' | 'right';
}

/** Cells are keyed by `tableCellKey(row, column)`; empty cells are simply absent. */
export interface TableElement extends SlideElementBase {
  type: 'table';
  rows: number;
  columns: number;
  columnWidths?: number[];
  rowHeights?: number[];
  cells: Record<string, TableCell>;
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
}

export interface DeckSnapshot {
  settings: DeckSettings;
  slides: SlideSnapshot[];
  themes: Theme[];
  layouts: SlideLayout[];
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
    for (const key of ['themeId', 'showFooter', 'showSlideNumber', 'showDate', 'footerText'] as const) {
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
      if (value === undefined || (element.type === 'richText' && (key === 'text' || key === ELEMENT_BODY_KEY))) continue;
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
    return node
      .toArray()
      .map((child) => visit(child as Y.XmlElement | Y.XmlText))
      .join('');
  };
  return fragment
    .toArray()
    .map((child) => visit(child as Y.XmlElement | Y.XmlText))
    .join('\n');
}

function readElement(value: Y.Map<unknown>): SlideElement | null {
  const json: Record<string, unknown> = {};
  value.forEach((entry, key) => {
    if (key === ELEMENT_BODY_KEY && entry instanceof Y.XmlFragment) json.text = fragmentText(entry);
    else json[key] = plain(entry);
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
  const themes = readCollection<Theme>(doc, THEMES_MAP);
  const layouts = readCollection<SlideLayout>(doc, LAYOUTS_MAP);
  return {
    settings: readDeckSettings(doc),
    slides: readSlideOrder(doc)
      .filter((id) => elementsOf(doc, id))
      .map((id) => readSlide(doc, id)),
    themes: themes.length ? themes : [DEFAULT_THEME],
    layouts: layouts.length ? layouts : DEFAULT_LAYOUTS,
  };
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
