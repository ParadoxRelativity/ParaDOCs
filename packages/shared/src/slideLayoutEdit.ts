/**
 * Edits to a deck's theme, master and layouts, and to which layout a slide
 * uses. Like slideEdit.ts these work on a Y.Doc inside one transaction, so the
 * editor, the assistant tools and importers share one way of changing a deck.
 *
 * A deck nobody has styled stores no theme, layouts or master and reads with
 * the defaults; the first edit here writes them out (ensureDeckStyle).
 */

import * as Y from 'yjs';
import { randomUuid } from './uuid.js';
import {
  DEFAULT_SLIDE_SIZE,
  ELEMENT_BODY_KEY,
  LAYOUTS_MAP,
  MASTER_MAP,
  SLIDE_ELEMENTS_KEY,
  THEMES_MAP,
  createSlide,
  fragmentText,
  readDeckSettings,
  readMaster,
  readSlideOrder,
  setSlideElement,
  slideMapName,
  writeDeckSettings,
  type SlideElement,
  type SlideSize,
} from './slides.js';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_THEME,
  PLACEHOLDER_STYLE_KEYS,
  defaultLayouts,
  defaultMaster,
  findLayout,
  isChromeKind,
  normalizeTheme,
  resolveLayoutPlaceholders,
  resolvePlaceholderElement,
  starterTheme,
  themeColor,
  type PlaceholderKind,
  type SlideBackground,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from './slideTheme.js';

function elementsOf(doc: Y.Doc, slideId: string): Y.Map<Y.Map<unknown>> | null {
  const elements = doc.getMap<unknown>(slideMapName(slideId)).get(SLIDE_ELEMENTS_KEY);
  return elements instanceof Y.Map ? (elements as Y.Map<Y.Map<unknown>>) : null;
}

function storedLayouts(doc: Y.Doc, size: SlideSize): SlideLayout[] {
  const layouts: SlideLayout[] = [];
  doc.getMap<unknown>(LAYOUTS_MAP).forEach((value) => layouts.push(value as SlideLayout));
  return layouts.length ? layouts.sort((a, b) => a.id.localeCompare(b.id)) : defaultLayouts(size);
}

/** Writes the default theme, layouts and master into a deck that has none, leaving what it has. */
export function ensureDeckStyle(doc: Y.Doc): void {
  doc.transact(() => {
    const { size } = readDeckSettings(doc);
    const themes = doc.getMap<unknown>(THEMES_MAP);
    if (themes.size === 0) themes.set(DEFAULT_THEME.id, DEFAULT_THEME);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    if (layouts.size === 0) for (const layout of defaultLayouts(size)) layouts.set(layout.id, layout);
    const master = doc.getMap<unknown>(MASTER_MAP);
    if (!master.has('id')) for (const [key, value] of Object.entries(defaultMaster(size))) master.set(key, value);
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Makes `theme` the deck's theme, adding it (or replacing the theme of that
 * id). The master's background becomes `background`, else the plain
 * background color. Slides' own backgrounds and colors are left alone.
 */
export function applyTheme(doc: Y.Doc, theme: Theme, background?: SlideBackground): void {
  doc.transact(() => {
    // Added first so a deck starting from this theme does not also get the default one.
    doc.getMap<unknown>(THEMES_MAP).set(theme.id, normalizeTheme(theme));
    ensureDeckStyle(doc);
    writeDeckSettings(doc, { themeId: theme.id });
    doc.getMap<unknown>(MASTER_MAP).set('background', background ?? { kind: 'color', color: themeColor('background1') });
  });
}

/** Applies one of the built-in starter themes; false for an unknown id. */
export function applyStarterTheme(doc: Y.Doc, id: string): boolean {
  const starter = starterTheme(id);
  if (!starter) return false;
  applyTheme(doc, structuredClone(starter.theme), starter.background && structuredClone(starter.background));
  return true;
}

export interface ThemePatch {
  name?: string;
  colors?: Partial<Theme['colors']>;
  fonts?: Partial<Theme['fonts']>;
  colorMap?: Theme['colorMap'] | null;
}

/** Changes the colors, fonts or name of a theme in place; every element naming a slot follows. */
export function updateTheme(doc: Y.Doc, themeId: string, patch: ThemePatch): void {
  doc.transact(() => {
    ensureDeckStyle(doc);
    const themes = doc.getMap<unknown>(THEMES_MAP);
    const current = themes.get(themeId) as Theme | undefined;
    if (!current) return;
    const next = normalizeTheme({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      colors: { ...current.colors, ...patch.colors },
      fonts: { ...current.fonts, ...patch.fonts },
    });
    if (patch.colorMap === null) delete next.colorMap;
    else if (patch.colorMap) next.colorMap = patch.colorMap;
    themes.set(themeId, next);
  });
}

// ---------------------------------------------------------------------------
// Master and layouts
// ---------------------------------------------------------------------------

export function updateMaster(doc: Y.Doc, patch: Partial<Omit<SlideMaster, 'id'>>): void {
  doc.transact(() => {
    ensureDeckStyle(doc);
    const master = doc.getMap<unknown>(MASTER_MAP);
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) master.set(key, value);
  });
}

export type LayoutPatch = Partial<Omit<SlideLayout, 'id' | 'background'>> & {
  /** Null gives the layout no background of its own, so it takes the master's. */
  background?: SlideBackground | null;
};

export function updateLayout(doc: Y.Doc, layoutId: string, patch: LayoutPatch): void {
  doc.transact(() => {
    ensureDeckStyle(doc);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    const current = layouts.get(layoutId) as SlideLayout | undefined;
    if (!current) return;
    const next: SlideLayout = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === 'background' && value === null) delete next.background;
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    layouts.set(layoutId, next);
  });
}

/** Adds a layout, a copy of `copyOf` when given, and returns its id. */
export function addLayout(doc: Y.Doc, name: string, copyOf?: string, makeId: () => string = () => randomUuid()): string {
  const id = `layout-${makeId().slice(0, 8)}`;
  doc.transact(() => {
    ensureDeckStyle(doc);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    const source = (copyOf ? (layouts.get(copyOf) as SlideLayout | undefined) : undefined) ?? { id, name, placeholders: [] };
    layouts.set(id, { ...structuredClone(source), id, name });
  });
  return id;
}

/**
 * Removes a layout. Slides on it move to the blank layout (else the first
 * other); the last layout cannot be removed. Returns whether one was.
 */
export function deleteLayout(doc: Y.Doc, layoutId: string): boolean {
  let removed = false;
  doc.transact(() => {
    ensureDeckStyle(doc);
    const layouts = doc.getMap<unknown>(LAYOUTS_MAP);
    if (!layouts.has(layoutId) || layouts.size < 2) return;
    layouts.delete(layoutId);
    const fallback = layouts.has(BLANK_LAYOUT_ID) ? BLANK_LAYOUT_ID : [...layouts.keys()].sort()[0];
    for (const slideId of readSlideOrder(doc)) {
      if (doc.getMap<unknown>(slideMapName(slideId)).get('layoutId') === layoutId) setSlideLayout(doc, slideId, fallback);
    }
    removed = true;
  });
  return removed;
}

// ---------------------------------------------------------------------------
// A slide's layout
// ---------------------------------------------------------------------------

function raw(map: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  map.forEach((value, key) => {
    if (key !== ELEMENT_BODY_KEY) out[key] = value instanceof Y.AbstractType ? value.toJSON() : value;
  });
  return out;
}

function hasContent(map: Y.Map<unknown>): boolean {
  if (map.get('type') === 'image') return typeof map.get('url') === 'string' && map.get('url') !== '';
  const body = map.get(ELEMENT_BODY_KEY);
  return body instanceof Y.XmlFragment && fragmentText(body).trim() !== '';
}

/** Text placeholders are interchangeable (a body can become a subtitle); titles and pictures keep to their own kind. */
function family(kind: PlaceholderKind): 'title' | 'text' | 'image' {
  return kind === 'title' ? 'title' : kind === 'image' ? 'image' : 'text';
}

/**
 * What an element filling a placeholder inherits, for the keys it does not
 * set itself; null when it fills none. Used to turn it into a plain element
 * (a copy, or when its placeholder goes away) without it jumping.
 */
export function inheritedPlaceholderProps(doc: Y.Doc, slideId: string, element: Y.Map<unknown>): Record<string, unknown> | null {
  if (typeof element.get('placeholder') !== 'string') return null;
  const { size } = readDeckSettings(doc);
  const layout = findLayout(storedLayouts(doc, size), String(doc.getMap<unknown>(slideMapName(slideId)).get('layoutId') ?? BLANK_LAYOUT_ID));
  const resolved = resolvePlaceholderElement(raw(element) as unknown as SlideElement, resolveLayoutPlaceholders(layout, readMaster(doc, size))) as unknown as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const key of ['x', 'y', 'width', 'height', ...PLACEHOLDER_STYLE_KEYS]) {
    if (!element.has(key) && resolved[key] !== undefined) props[key] = resolved[key];
  }
  return props;
}

/**
 * Moves a slide to another layout (or, with its own layout, adds the
 * placeholders it lacks). Boxes already filling a placeholder move to the
 * matching one of the new layout, by kind then order, keeping their content
 * and anything they set themselves. Those with nowhere to go are dropped when
 * empty and otherwise become plain boxes where they were. Placeholders the
 * slide lacks are added empty.
 */
export function setSlideLayout(doc: Y.Doc, slideId: string, layoutId: string): void {
  doc.transact(() => {
    const slide = doc.getMap<unknown>(slideMapName(slideId));
    const elements = elementsOf(doc, slideId);
    if (!elements) return;
    const { size } = readDeckSettings(doc);
    const layouts = storedLayouts(doc, size);
    const master = readMaster(doc, size);
    const oldLayout = findLayout(layouts, String(slide.get('layoutId') ?? BLANK_LAYOUT_ID));
    const next = layouts.find((l) => l.id === layoutId);
    if (!next) return;
    const slots = resolveLayoutPlaceholders(next, master).filter((p) => !isChromeKind(p.kind));
    const oldSlots = resolveLayoutPlaceholders(oldLayout, master);

    const filled = [...elements.entries()]
      .filter(([, map]) => typeof map.get('placeholder') === 'string')
      .sort(([, a], [, b]) => Number(a.get('z') ?? 0) - Number(b.get('z') ?? 0));
    const kindOf = (map: Y.Map<unknown>): PlaceholderKind =>
      oldSlots.find((p) => p.id === map.get('placeholder'))?.kind ?? (map.get('type') === 'image' ? 'image' : 'body');

    const taken = new Set<string>();
    const target = new Map<string, string>();
    const claim = (exact: boolean) => {
      for (const [id, map] of filled) {
        if (target.has(id)) continue;
        const slot = slots.find((s) => !taken.has(s.id) && family(s.kind) === family(kindOf(map)) && (!exact || s.id === map.get('placeholder')));
        if (!slot) continue;
        taken.add(slot.id);
        target.set(id, slot.id);
      }
    };
    // The same placeholder when the new layout still has it, then the next free one of the same kind.
    claim(true);
    claim(false);

    let top = 0;
    elements.forEach((map) => void (top = Math.max(top, Number(map.get('z') ?? 0))));

    for (const [id, map] of filled) {
      const slotId = target.get(id);
      if (slotId) {
        if (map.get('placeholder') !== slotId) map.set('placeholder', slotId);
      } else if (!hasContent(map)) {
        elements.delete(id);
      } else {
        const props = inheritedPlaceholderProps(doc, slideId, map) ?? {};
        for (const [key, value] of Object.entries(props)) map.set(key, value);
        map.delete('placeholder');
      }
    }
    slide.set('layoutId', layoutId);

    for (const slot of slots) {
      if (taken.has(slot.id)) continue;
      top += 1;
      const base = { id: randomUuid(), placeholder: slot.id, z: top };
      setSlideElement(doc, slideId, (slot.kind === 'image' ? { ...base, type: 'image', url: '' } : { ...base, type: 'richText' }) as unknown as SlideElement);
    }
  });
}

/** Forgets what a placeholder box set itself (position, size, text style), so it follows its layout again. */
export function resetPlaceholder(doc: Y.Doc, slideId: string, elementId: string): void {
  doc.transact(() => {
    const map = elementsOf(doc, slideId)?.get(elementId);
    if (!map || typeof map.get('placeholder') !== 'string') return;
    for (const key of ['x', 'y', 'width', 'height', 'rotation', ...PLACEHOLDER_STYLE_KEYS]) map.delete(key);
  });
}

/**
 * A new deck: the starter theme applied, and a first Title slide so the theme
 * shows. Returns the Y.Doc update to store as the presentation's content.
 */
export function createStyledDeck(themeId: string, size: SlideSize = DEFAULT_SLIDE_SIZE): Uint8Array {
  const doc = new Y.Doc();
  const starter = starterTheme(themeId) ?? starterTheme('default')!;
  writeDeckSettings(doc, { size });
  applyTheme(doc, structuredClone(starter.theme), starter.background && structuredClone(starter.background));
  const slideId = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
  setSlideLayout(doc, slideId, 'title');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

