import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_THEME,
  LAYOUTS_MAP,
  ensureDeckStyle,
  addLayout,
  applyTheme,
  createSlide,
  defaultLayouts,
  defaultMaster,
  deleteSlide,
  isChromeKind,
  isThemeColor,
  makeTemplateDeck,
  normalizeTheme,
  notesFragmentName,
  readDeck,
  readSlideOrder,
  resolveLayoutPlaceholders,
  resolvePlaceholderElement,
  resolveSlideColor,
  setSlideElement,
  updateLayout,
  updateMaster,
  writeDeckSettings,
  type LayoutPlaceholder,
  type PlaceholderKind,
  type SlideBackground,
  type SlideElement,
  type SlideLayout,
  type SlideMaster,
  type Theme,
} from '@paradocs/shared';
import {
  ReportBuilder,
  mediaKeyOf,
  type ImportProgress,
  type ImportedDeck,
  type ImportedLayout,
  type ImportedSlide,
} from './slideImportTypes';
import { randomId } from './util';

/**
 * Getting an imported presentation into a Slides deck.
 *
 * The file is read, and its pictures are uploaded, before the presentation
 * is opened. {@link encodeImport} then writes the whole deck into a fresh
 * Y.Doc in a single transaction ({@link applyImport}), and that is stored as
 * the new presentation's content at once, so a deck imported alongside others
 * and never opened is not left empty. Only the import report waits here, for
 * the editor to show the first time it opens the deck.
 *
 * Every source of slides enters here. `.pptx` and `.odp` come from the
 * parsers (slideImportClient.ts); PARA-96 adds converter output and PDF pages,
 * which only need to produce an {@link ImportedDeck}.
 */
const pending = new Map<string, ImportedDeck>();

export function rememberImport(presentationId: string, deck: ImportedDeck): void {
  pending.set(presentationId, deck);
}

/** A new presentation's content, from an imported deck whose media has been resolved. */
export function encodeImport(deck: ImportedDeck): { update: Uint8Array; slides: number } {
  const doc = new Y.Doc();
  try {
    const { slideIds } = applyImport(doc, deck);
    return { update: Y.encodeStateAsUpdate(doc), slides: slideIds.length };
  } finally {
    doc.destroy();
  }
}

/**
 * A presentation template's deck, from a file imported as one whose media has
 * been resolved: its look, and one Title slide in place of its slides.
 */
export function encodeTemplateImport(deck: ImportedDeck): Uint8Array {
  const doc = new Y.Doc();
  try {
    applyImport(doc, { ...deck, slides: [] });
    makeTemplateDeck(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** The deck waiting for this presentation, once; null when there is none. */
export function claimImport(presentationId: string): ImportedDeck | null {
  const deck = pending.get(presentationId) ?? null;
  pending.delete(presentationId);
  return deck;
}

// ---------------------------------------------------------------------------
// Pictures and media
// ---------------------------------------------------------------------------

export interface UploadedMedia {
  url: string;
}

/**
 * Uploads every picture, video and sound of a deck, a few at a time. One that
 * cannot be uploaded (too large, refused) does not stop the rest: it is
 * returned in `failed`, and {@link resolveMedia} leaves out what used it.
 */
export async function uploadImportMedia(
  deck: ImportedDeck,
  upload: (file: File) => Promise<UploadedMedia>,
  onProgress?: (progress: ImportProgress) => void,
  concurrency = 3,
): Promise<{ urls: Map<string, string>; failed: { key: string; name: string; reason: string }[] }> {
  const urls = new Map<string, string>();
  const failed: { key: string; name: string; reason: string }[] = [];
  const queue = [...deck.media];
  let done = 0;
  const total = queue.length;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const file = new File([item.data as BlobPart], item.name, { type: item.mimeType });
        urls.set(item.key, (await upload(file)).url);
      } catch (err) {
        failed.push({ key: item.key, name: item.name, reason: err instanceof Error ? err.message : 'upload failed' });
      }
      done += 1;
      onProgress?.({ stage: 'uploading', done, total, message: `Uploading pictures and media (${done} of ${total})` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { urls, failed };
}

/**
 * The deck with each `import-media:` address replaced by where its file was
 * uploaded. An element whose file is missing is left out, a missing
 * background reverts to the master's, and both go in the report.
 */
export function resolveMedia(deck: ImportedDeck, urls: Map<string, string>, failed: { name: string }[] = []): ImportedDeck {
  const report = new ReportBuilder();
  let lost = 0;
  const resolve = (url: string | undefined): string | null | undefined => {
    if (typeof url !== 'string') return url;
    const key = mediaKeyOf(url);
    if (key === null) return url;
    return urls.get(key) ?? null;
  };
  const elementsOf = (elements: SlideElement[], slide: number | null): SlideElement[] =>
    elements.flatMap((element) => {
      const url = (element as { url?: string }).url;
      const resolved = resolve(url);
      if (resolved === null) {
        lost += 1;
        report.dropped('Pictures and media that could not be uploaded', slide);
        return [];
      }
      return [resolved === url ? element : ({ ...element, url: resolved } as SlideElement)];
    });
  const backgroundOf = (background: SlideBackground | undefined, slide: number | null): SlideBackground | undefined => {
    if (background?.kind !== 'image') return background;
    const resolved = resolve(background.url);
    if (resolved === null) {
      lost += 1;
      report.dropped('Pictures and media that could not be uploaded', slide);
      return undefined;
    }
    return { kind: 'image', url: resolved as string };
  };

  const slides = deck.slides.map((slide, i): ImportedSlide => {
    const background = backgroundOf(slide.background, i + 1);
    return { ...slide, elements: elementsOf(slide.elements, i + 1), ...(background ? { background } : { background: undefined }) };
  });
  const layouts = deck.layouts?.map((layout): ImportedLayout => {
    const background = backgroundOf(layout.background, null);
    return { ...layout, ...(layout.elements ? { elements: elementsOf(layout.elements, null) } : {}), ...(background ? { background } : { background: undefined }) };
  });
  const master = deck.master && {
    ...deck.master,
    ...(deck.master.elements ? { elements: elementsOf(deck.master.elements, null) } : {}),
    ...(deck.master.background ? { background: backgroundOf(deck.master.background, null) } : {}),
  };
  const merged = [...deck.report.items, ...report.build().items];
  if (failed.length > 0 && lost > 0) {
    const first = failed
      .slice(0, 3)
      .map((f) => f.name)
      .join(', ');
    const item = merged.find((i) => i.feature === 'Pictures and media that could not be uploaded');
    if (item) item.detail = `${first}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}`;
  }
  return { ...deck, slides, ...(layouts ? { layouts } : {}), ...(master ? { master } : {}), media: [], report: { items: merged } };
}

// ---------------------------------------------------------------------------
// Writing the deck
// ---------------------------------------------------------------------------

/** Speaker notes in the structure the notes editor (BlockNote) keeps: a block per line. */
function writeNotes(ydoc: Y.Doc, slideId: string, lines: string[]): void {
  if (lines.length === 0) return;
  const group = new Y.XmlElement('blockGroup');
  group.insert(
    0,
    lines.map((line) => {
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', randomId());
      const paragraph = new Y.XmlElement('paragraph');
      if (line) {
        const text = new Y.XmlText();
        text.insert(0, line);
        paragraph.insert(0, [text]);
      }
      container.insert(0, [paragraph]);
      return container;
    }),
  );
  ydoc.getXmlFragment(notesFragmentName(slideId)).insert(0, [group]);
}

export interface ApplyResult {
  slideIds: string[];
  layoutIds: string[];
}

/**
 * Writes a deck into a presentation's Y.Doc in one transaction. Whatever slides
 * the presentation had are replaced; so are its theme (when the source has one),
 * layouts and master pieces the source supplies.
 */
export function applyImport(ydoc: Y.Doc, deck: ImportedDeck): ApplyResult {
  const slideIds: string[] = [];
  const layoutIds: string[] = [];
  ydoc.transact(() => {
    for (const id of readSlideOrder(ydoc)) deleteSlide(ydoc, id);

    writeDeckSettings(ydoc, { size: deck.size, ...deck.settings });
    ensureDeckStyle(ydoc);

    if (deck.theme) applyTheme(ydoc, { id: 'imported', ...deck.theme }, deck.master?.background);
    else if (deck.master?.background) updateMaster(ydoc, { background: deck.master.background });

    if (deck.master) {
      const fallback = defaultMaster(deck.size);
      const placeholders = [...(deck.master.placeholders ?? fallback.placeholders)];
      // A master without a footer or date placeholder still lets layouts show them.
      for (const standard of fallback.placeholders) if (!placeholders.some((p) => p.kind === standard.kind)) placeholders.push(standard);
      updateMaster(ydoc, {
        ...(deck.master.name ? { name: deck.master.name } : {}),
        placeholders,
        ...(deck.master.elements ? { elements: deck.master.elements } : {}),
      });
    }

    const layouts = ydoc.getMap<unknown>(LAYOUTS_MAP);
    const ids: (string | null)[] = [];
    if (deck.layouts && deck.layouts.length > 0) {
      // Added before the stock layouts go: with none left, adding one would restore them all.
      const stock = [...layouts.keys()];
      deck.layouts.forEach((layout, index) => {
        const id = addLayout(ydoc, layout.name, undefined, () => `i${index.toString(36).padStart(7, '0')}`);
        updateLayout(ydoc, id, {
          name: layout.name,
          ...(layout.type ? { type: layout.type } : {}),
          ...(layout.background ? { background: layout.background } : {}),
          placeholders: layout.placeholders,
          ...(layout.elements ? { elements: layout.elements } : {}),
          ...(layout.hideMasterElements ? { hideMasterElements: true } : {}),
        });
        ids.push(id);
        layoutIds.push(id);
      });
      for (const key of stock) layouts.delete(key);
    }
    // Slides on no layout use the blank one, which an imported set (or an earlier import) may not have.
    if (deck.slides.some((slide) => slide.layout === null || ids[slide.layout ?? -1] === undefined) && !layouts.has(BLANK_LAYOUT_ID)) {
      const blank = defaultLayouts(deck.size).find((l) => l.id === BLANK_LAYOUT_ID);
      if (blank) layouts.set(BLANK_LAYOUT_ID, blank satisfies SlideLayout);
    }

    deck.slides.forEach((slide) => {
      const layoutId = (slide.layout !== null && ids[slide.layout]) || BLANK_LAYOUT_ID;
      const id = createSlide(ydoc, {
        layoutId,
        ...(slide.background ? { background: slide.background } : {}),
        hidden: slide.hidden ?? false,
        ...(slide.transition ? { transition: slide.transition } : {}),
      });
      slide.elements.forEach((element, z) => setSlideElement(ydoc, id, { ...element, z: z + 1 }));
      writeNotes(ydoc, id, slide.notes);
      slideIds.push(id);
    });
  });
  return { slideIds, layoutIds };
}

// ---------------------------------------------------------------------------
// Slides added to a deck (pasted from PowerPoint)
// ---------------------------------------------------------------------------

/**
 * How pasted slides are styled, as PowerPoint's paste options offer:
 * `deck` puts each on the deck's own layout of the same kind and lets the
 * deck's theme restyle it; `source` brings its layout across, master and
 * theme colors and fonts baked in, so it looks as it did.
 */
export type PasteFormatting = 'deck' | 'source';

/** Text placeholders stand in for one another; titles and pictures keep to their own kind (as setSlideLayout matches them). */
function family(kind: PlaceholderKind): 'title' | 'text' | 'image' {
  return kind === 'title' ? 'title' : kind === 'image' ? 'image' : 'text';
}

/** The source deck's master in full, with the default's pieces where it has none (as applyImport writes it). */
function sourceMaster(deck: ImportedDeck): SlideMaster {
  const fallback = defaultMaster(deck.size);
  const placeholders = [...(deck.master?.placeholders ?? fallback.placeholders)];
  for (const standard of fallback.placeholders) if (!placeholders.some((p) => p.kind === standard.kind)) placeholders.push(standard);
  return { ...fallback, ...deck.master, placeholders, elements: deck.master?.elements ?? [] };
}

/** A copy of a value with every theme color in it made concrete in `theme`, so another deck's theme cannot restyle it. */
function bakeColors<T>(value: T, theme: Theme): T {
  if (typeof value === 'string') return (isThemeColor(value) ? resolveSlideColor(value, theme) : value) as T;
  if (Array.isArray(value)) return value.map((item) => bakeColors(item, theme)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bakeColors(item, theme)])) as T;
  }
  return value;
}

/** The deck layout a source layout becomes under `deck` formatting: the same PowerPoint type, else the same name, else the same placeholders. */
function matchLayout(source: SlideLayout | undefined, layouts: SlideLayout[]): SlideLayout | undefined {
  if (!source) return undefined;
  const shape = (layout: SlideLayout) =>
    layout.placeholders
      .filter((p) => !isChromeKind(p.kind))
      .map((p) => family(p.kind))
      .sort()
      .join(',');
  return (
    (source.type ? layouts.find((l) => l.type === source.type) : undefined) ??
    layouts.find((l) => l.name.toLowerCase() === source.name.toLowerCase()) ??
    layouts.find((l) => shape(l) === shape(source))
  );
}

/**
 * A source layout made to look the same in any deck: its placeholders with
 * everything inherited from the source master written out (the theme's fonts
 * included), the master's background and decorations folded in, and every
 * theme color made concrete.
 */
function bakeLayout(layout: SlideLayout, master: SlideMaster, theme: Theme, name: string): Omit<SlideLayout, 'id'> {
  const placeholders = resolveLayoutPlaceholders(layout, master).map((p): LayoutPlaceholder => {
    const font = p.kind === 'image' ? {} : { fontFamily: p.kind === 'title' ? theme.fonts.heading : theme.fonts.body };
    return { id: p.id, kind: p.kind, x: p.x, y: p.y, width: p.width, height: p.height, style: { ...font, ...p.style }, prompt: p.prompt };
  });
  return bakeColors(
    {
      name,
      ...(layout.type ? { type: layout.type } : {}),
      background: layout.background ?? master.background,
      placeholders,
      elements: [...(layout.hideMasterElements ? [] : master.elements), ...(layout.elements ?? [])],
      hideMasterElements: true,
    },
    theme,
  );
}

/** JSON with keys in a fixed order (and undefined left out), so two layouts compare by content however they were written. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sameLayout = (a: Omit<SlideLayout, 'id'>, b: SlideLayout) => canonical({ ...b, id: undefined }) === canonical(a);

/**
 * Adds an imported deck's slides to a presentation at `index` in its running
 * order, in one transaction, leaving its theme, master and other slides as
 * they are. The deck's media must already be resolved (see resolveMedia), and
 * it should have been read at this presentation's size (`fitTo`).
 */
export function insertImport(ydoc: Y.Doc, deck: ImportedDeck, options: { index: number; formatting: PasteFormatting }): ApplyResult {
  const slideIds: string[] = [];
  const layoutIds: string[] = [];
  ydoc.transact(() => {
    ensureDeckStyle(ydoc);
    const target = readDeck(ydoc);
    const layoutsMap = ydoc.getMap<unknown>(LAYOUTS_MAP);
    const master = sourceMaster(deck);
    const theme = normalizeTheme({ id: 'source', ...(deck.theme ?? DEFAULT_THEME) });
    const sourceLayouts = (deck.layouts ?? []).map((layout, i): SlideLayout => ({ ...layout, id: `source-${i}` }));

    const ensureBlank = (): string => {
      if (!layoutsMap.has(BLANK_LAYOUT_ID)) {
        const blank = defaultLayouts(target.settings.size).find((l) => l.id === BLANK_LAYOUT_ID);
        if (blank) layoutsMap.set(BLANK_LAYOUT_ID, blank satisfies SlideLayout);
      }
      return BLANK_LAYOUT_ID;
    };

    // Each source layout the slides use, once: the deck layout it lands on.
    const placed = new Map<number, string>();
    const layoutFor = (index: number | null): string => {
      if (index === null || !sourceLayouts[index]) return ensureBlank();
      const known = placed.get(index);
      if (known) return known;
      const source = sourceLayouts[index];
      let id: string;
      if (options.formatting === 'deck') {
        id = matchLayout(source, target.layouts)?.id ?? ensureBlank();
      } else {
        const baked = bakeLayout(source, master, theme, deck.theme?.name ? `${source.name} (${deck.theme.name})` : source.name);
        // Pasting from the same deck again reuses what the last paste brought in.
        const existing = [...layoutsMap.values()].find((l) => sameLayout(baked, l as SlideLayout)) as SlideLayout | undefined;
        if (existing) id = existing.id;
        else {
          id = addLayout(ydoc, baked.name);
          updateLayout(ydoc, id, baked);
          layoutIds.push(id);
        }
      }
      placed.set(index, id);
      return id;
    };

    deck.slides.forEach((slide, i) => {
      const layoutId = layoutFor(slide.layout);
      const source = slide.layout === null ? undefined : sourceLayouts[slide.layout];
      const sourceSlots = source ? resolveLayoutPlaceholders(source, master) : [];
      let elements = slide.elements;
      let background = slide.background;

      if (options.formatting === 'deck') {
        // Placeholders move to the deck layout's, by kind and then order; one with nowhere to go stays where it was, as a plain box.
        const layout = (layoutsMap.get(layoutId) as SlideLayout | undefined) ?? target.layouts.find((l) => l.id === layoutId);
        const slots = layout ? resolveLayoutPlaceholders(layout, target.master).filter((p) => !isChromeKind(p.kind)) : [];
        const taken = new Set<string>();
        elements = elements.map((element) => {
          const raw = element as SlideElement & { placeholder?: string };
          if (typeof raw.placeholder !== 'string') return element;
          const from = sourceSlots.find((p) => p.id === raw.placeholder);
          const kind = from?.kind ?? (element.type === 'image' ? 'image' : 'body');
          const slot = slots.find((s) => !taken.has(s.id) && s.id === raw.placeholder && family(s.kind) === family(kind)) ?? slots.find((s) => !taken.has(s.id) && family(s.kind) === family(kind));
          if (slot) {
            taken.add(slot.id);
            return { ...element, placeholder: slot.id } as SlideElement;
          }
          // What it inherited from the source placeholder (position, size, text style) is written onto it.
          const { placeholderKind: _kind, prompt: _prompt, ...plain } = resolvePlaceholderElement(element, sourceSlots) as SlideElement & { placeholderKind?: string; prompt?: string };
          return { ...plain, placeholder: undefined } as SlideElement;
        });
      } else {
        // A text box of its own takes the source theme's body font, which the deck's theme would otherwise replace.
        elements = bakeColors(
          elements.map((element) =>
            element.type === 'richText' && !element.fontFamily && typeof element.placeholder !== 'string' ? { ...element, fontFamily: theme.fonts.body } : element,
          ),
          theme,
        );
        background = background && bakeColors(background, theme);
      }

      const id = createSlide(ydoc, {
        layoutId,
        index: options.index + i,
        ...(background ? { background } : {}),
        hidden: slide.hidden ?? false,
        ...(slide.transition ? { transition: slide.transition } : {}),
      });
      elements.forEach((element, z) => setSlideElement(ydoc, id, { ...element, z: z + 1 }));
      writeNotes(ydoc, id, slide.notes);
      slideIds.push(id);
    });
  });
  return { slideIds, layoutIds };
}
