/**
 * Presentation templates (PARA-110): a deck's look kept to start other decks
 * from, or to put on one that already has slides.
 *
 * A template is stored as a small deck of its own: the theme, the master and
 * every layout, the footer switches, and one Title slide. A deck made from it
 * is a copy of that deck, so it starts already looking right. Applying one to
 * a deck that has slides swaps in its theme, master and layouts, and moves
 * each slide to the layout of the same kind.
 */

import * as Y from 'yjs';
import { z } from 'zod';
import { randomUuid } from './uuid.js';
import {
  LAYOUTS_MAP,
  MASTER_MAP,
  THEMES_MAP,
  createSlide,
  deleteSlide,
  readDeck,
  readDeckSettings,
  readSlideOrder,
  slideMapName,
  writeDeckSettings,
  type DeckSettings,
  type DeckSnapshot,
  type SlideElement,
  type SlideSize,
  type SlideSnapshot,
} from './slides.js';
import { ensureDeckStyle, setSlideLayout } from './slideLayoutEdit.js';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_THEME,
  isChromeKind,
  normalizeTheme,
  resolveLayoutPlaceholders,
  type PlaceholderKind,
  type PlaceholderStyle,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from './slideTheme.js';

// ---------------------------------------------------------------------------
// What the API carries
// ---------------------------------------------------------------------------

/** Sample text over a template's preview, where its Title layout puts the title and subtitle. */
export interface TemplatePreviewText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: PlaceholderStyle;
}

/** Enough to draw a template's Title slide as a thumbnail, without opening it. */
export interface TemplatePreview {
  size: SlideSize;
  theme: Theme;
  /** The Title slide, resolved: its background and its master's and layout's decorations are in `frame`. */
  slide: SlideSnapshot;
  samples: TemplatePreviewText[];
}

export interface PresentationTemplateSummary {
  id: string;
  name: string;
  description: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Whoever saved it, an owner or an admin may rename or delete it; everyone in the workspace may use it. */
  canManage: boolean;
  preview: TemplatePreview | null;
}

/** A template's look as plain data: what applying it to a deck writes. */
export interface TemplateStyle {
  settings: DeckSettings;
  theme: Theme;
  master: SlideMaster;
  layouts: SlideLayout[];
}

export const savePresentationTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

export const updatePresentationTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

export const applyPresentationTemplateSchema = z.object({
  templateId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Reading and writing a template deck
// ---------------------------------------------------------------------------

/** The layout a template's slide uses: PowerPoint's Title Slide, else one named like it, else the first. */
export function titleLayoutOf(layouts: SlideLayout[]): SlideLayout | undefined {
  return (
    layouts.find((l) => l.type === 'title') ??
    layouts.find((l) => l.id === 'title') ??
    layouts.find((l) => /^title( slide)?$/i.test(l.name.trim())) ??
    layouts.find((l) => l.id !== BLANK_LAYOUT_ID) ??
    layouts[0]
  );
}

/** A deck's look, read from its snapshot: the theme it uses, its master and its layouts. */
export function templateStyleOf(deck: Pick<DeckSnapshot, 'settings' | 'themes' | 'master' | 'layouts'>): TemplateStyle {
  return {
    settings: deck.settings,
    theme: deck.themes.find((t) => t.id === deck.settings.themeId) ?? deck.themes[0] ?? DEFAULT_THEME,
    master: deck.master,
    layouts: deck.layouts,
  };
}

/**
 * Turns a deck into a template in place: its slides are dropped, every theme
 * but the one it uses goes, and one empty slide on the Title layout is added.
 * Run on a fresh copy, never on a deck someone is editing.
 */
export function makeTemplateDeck(doc: Y.Doc): void {
  doc.transact(() => {
    ensureDeckStyle(doc);
    for (const id of readSlideOrder(doc)) deleteSlide(doc, id);
    const { themeId } = readDeckSettings(doc);
    const themes = doc.getMap<unknown>(THEMES_MAP);
    if (themes.has(themeId)) {
      for (const id of [...themes.keys()]) if (id !== themeId) themes.delete(id);
    } else {
      writeDeckSettings(doc, { themeId: [...themes.keys()][0] ?? DEFAULT_THEME.id });
    }
    const layouts: SlideLayout[] = [];
    doc.getMap<unknown>(LAYOUTS_MAP).forEach((value) => layouts.push(value as SlideLayout));
    const title = titleLayoutOf(layouts.sort((a, b) => a.id.localeCompare(b.id)));
    const slideId = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
    if (title) setSlideLayout(doc, slideId, title.id);
  });
}

/**
 * A template made from a deck, as a Y.Doc update: a fresh document holding
 * the deck's look (so none of its slides or editing history comes along) and
 * one Title slide.
 */
export function templateDeckFrom(source: Y.Doc): Uint8Array {
  const doc = new Y.Doc();
  try {
    writeStyle(doc, templateStyleOf(readDeck(source)));
    makeTemplateDeck(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** Writes a look into a deck that has none yet: settings (size included), theme, master and layouts as they are. */
function writeStyle(doc: Y.Doc, style: TemplateStyle): void {
  doc.transact(() => {
    writeDeckSettings(doc, style.settings);
    doc.getMap<unknown>(THEMES_MAP).set(style.theme.id, normalizeTheme(structuredClone(style.theme)));
    writeDeckSettings(doc, { themeId: style.theme.id });
    const master = doc.getMap<unknown>(MASTER_MAP);
    for (const [key, value] of Object.entries(structuredClone(style.master))) master.set(key, value);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    for (const layout of style.layouts) layouts.set(layout.id, structuredClone(layout));
  });
}

/** What a template looks like, for its thumbnail: its Title slide with sample text where the title and subtitle go. */
export function templatePreview(doc: Y.Doc): TemplatePreview | null {
  const deck = readDeck(doc);
  const slide = deck.slides[0];
  if (!slide) return null;
  const style = templateStyleOf(deck);
  const layout = deck.layouts.find((l) => l.id === slide.layoutId);
  const placeholders = layout ? resolveLayoutPlaceholders(layout, deck.master) : [];
  const title = placeholders.find((p) => p.kind === 'title');
  const subtitle = placeholders.find((p) => p.kind === 'subtitle') ?? placeholders.find((p) => p.kind === 'body');
  const sample = (text: string, p: (typeof placeholders)[number] | undefined, font: string): TemplatePreviewText[] =>
    p ? [{ text, x: p.x, y: p.y, width: p.width, height: p.height, style: { ...p.style, fontFamily: p.style.fontFamily ?? font } }] : [];
  return {
    size: deck.settings.size,
    theme: style.theme,
    // The empty placeholder boxes draw nothing; the samples stand in for them.
    slide: { ...slide, elements: slide.elements.filter((e) => !(e as { placeholder?: string }).placeholder) },
    samples: [...sample('Presentation title', title, style.theme.fonts.heading), ...sample('Subtitle', subtitle, style.theme.fonts.body)],
  };
}

const UPLOAD_PATH = /^\/uploads\/[^?#]+$/;

/** The uploaded files a template's master and layouts show (pictures, backgrounds), as their served addresses. */
export function templateAssetUrls(style: Pick<TemplateStyle, 'master' | 'layouts'>): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (UPLOAD_PATH.test(value)) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(style.master);
  walk(style.layouts);
  return [...found];
}

// ---------------------------------------------------------------------------
// Applying a template to a deck that has slides
// ---------------------------------------------------------------------------

function scaleBoxed<T>(value: T, sx: number, sy: number): T {
  const out = { ...value } as Record<string, unknown>;
  if (typeof out.x === 'number') out.x = Math.round(out.x * sx);
  if (typeof out.width === 'number') out.width = Math.round(out.width * sx);
  if (typeof out.y === 'number') out.y = Math.round(out.y * sy);
  if (typeof out.height === 'number') out.height = Math.round(out.height * sy);
  if (typeof out.fontSize === 'number') out.fontSize = Math.round(out.fontSize * sy);
  const style = out.style as PlaceholderStyle | undefined;
  if (style?.fontSize !== undefined) out.style = { ...style, fontSize: Math.round(style.fontSize * sy) };
  return out as T;
}

/** A look drawn for one slide size, fitted to another: positions scale with the slide, text with its height. */
export function fitTemplateStyle(style: TemplateStyle, size: SlideSize): TemplateStyle {
  const sx = size.width / style.settings.size.width;
  const sy = size.height / style.settings.size.height;
  if (sx === 1 && sy === 1) return style;
  const elements = (list: SlideElement[] | undefined) => list?.map((e) => scaleBoxed(e, sx, sy));
  return {
    ...style,
    settings: { ...style.settings, size },
    master: { ...style.master, placeholders: style.master.placeholders.map((p) => scaleBoxed(p, sx, sy)), elements: elements(style.master.elements) ?? [] },
    layouts: style.layouts.map((layout) => ({
      ...layout,
      placeholders: layout.placeholders.map((p) => scaleBoxed(p, sx, sy)),
      ...(layout.elements ? { elements: elements(layout.elements) } : {}),
    })),
  };
}

const kindsOf = (layout: SlideLayout | undefined): PlaceholderKind[] => (layout?.placeholders ?? []).map((p) => p.kind).filter((k) => !isChromeKind(k));

/** A layout's name without the words that differ between apps: "Title Slide" and "Title" are the same layout. */
const plainName = (name: string) => name.trim().toLowerCase().replace(/\s+(slide|layout)$/, '').replace(/\s+/g, ' ');

/**
 * The template layout a slide on `current` moves to: the one of the same
 * PowerPoint type, else the same name, else the same id, else the one whose
 * placeholders are most like it (so a slide on no layout goes to a blank one).
 */
export function matchTemplateLayout(current: SlideLayout | undefined, candidates: SlideLayout[]): SlideLayout | undefined {
  if (current?.type) {
    const byType = candidates.find((l) => l.type === current.type);
    if (byType) return byType;
  }
  if (current) {
    const byName = candidates.find((l) => plainName(l.name) === plainName(current.name)) ?? candidates.find((l) => l.id === current.id);
    if (byName) return byName;
  }
  const want = kindsOf(current);
  let best: SlideLayout | undefined;
  let bestScore = Infinity;
  for (const layout of candidates) {
    const have = kindsOf(layout);
    const counts = new Map<PlaceholderKind, number>();
    for (const k of want) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const k of have) counts.set(k, (counts.get(k) ?? 0) - 1);
    // A layout with the same kinds of box, then the fewest boxes left over or missing.
    const score = [...counts.values()].reduce((sum, n) => sum + Math.abs(n), 0);
    if (score < bestScore) {
      best = layout;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Puts a template's look on a deck in one transaction (one undo step): its
 * theme, master and layouts replace the deck's, sized to the deck, and each
 * slide moves to the matching template layout keeping its content. The
 * deck's footer switches, size and slides' own backgrounds stay as they are.
 */
export function applyTemplate(doc: Y.Doc, template: TemplateStyle): void {
  doc.transact(() => {
    ensureDeckStyle(doc);
    const { size } = readDeckSettings(doc);
    const style = fitTemplateStyle(template, size);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    const old = new Map<string, SlideLayout>();
    layouts.forEach((value, id) => old.set(id, value as SlideLayout));

    // Added under ids of their own first, so slides can move across while the old ones are still there to move from.
    const temporary = new Map<string, string>();
    for (const layout of style.layouts) {
      const id = `tmp-${randomUuid()}`;
      temporary.set(layout.id, id);
      layouts.set(id, { ...structuredClone(layout), id });
    }
    const final = new Map<string, string>();
    for (const slideId of readSlideOrder(doc)) {
      const slide = doc.getMap<unknown>(slideMapName(slideId));
      const target = matchTemplateLayout(old.get(String(slide.get('layoutId') ?? BLANK_LAYOUT_ID)), style.layouts);
      if (!target) continue;
      setSlideLayout(doc, slideId, temporary.get(target.id)!);
      final.set(slideId, target.id);
    }
    // Then the old ones go, and the new ones take the template's own ids, which keep its order.
    for (const id of old.keys()) layouts.delete(id);
    for (const layout of style.layouts) {
      layouts.delete(temporary.get(layout.id)!);
      layouts.set(layout.id, structuredClone(layout));
    }
    for (const [slideId, layoutId] of final) doc.getMap<unknown>(slideMapName(slideId)).set('layoutId', layoutId);

    const master = doc.getMap<unknown>(MASTER_MAP);
    for (const [key, value] of Object.entries(structuredClone(style.master))) master.set(key, value);
    doc.getMap<unknown>(THEMES_MAP).set(style.theme.id, normalizeTheme(structuredClone(style.theme)));
    writeDeckSettings(doc, { themeId: style.theme.id });
  });
}
