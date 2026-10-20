import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  LAYOUTS_MAP,
  ensureDeckStyle,
  addLayout,
  applyTheme,
  createSlide,
  defaultLayouts,
  defaultMaster,
  deleteSlide,
  notesFragmentName,
  readSlideOrder,
  setSlideElement,
  updateLayout,
  updateMaster,
  writeDeckSettings,
  type SlideBackground,
  type SlideElement,
  type SlideLayout,
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
