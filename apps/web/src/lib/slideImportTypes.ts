import type { DeckSettings, SlideBackground, SlideElement, SlideLayout, SlideMaster, SlideSize, SlideTransition, Theme } from '@paradocs/shared';

/**
 * What an importer hands to {@link applyImport} (lib/slideImport.ts): a whole
 * deck in the shapes the Y.Doc stores, with nothing written yet.
 *
 * Every importer ends here: the .pptx and .odp parsers (lib/pptx.ts,
 * lib/odp.ts) today, and PARA-96's converter output and PDF pages tomorrow. A
 * PDF page is just a slide with one full-bleed image element, so a source that
 * knows nothing of themes or layouts leaves them out and the deck keeps its
 * defaults.
 *
 * Pictures, video and sound are not uploaded by the parser (it may run in a
 * worker, before the presentation exists). Elements and backgrounds name their
 * file as `import-media:<key>` and the bytes wait in {@link ImportedDeck.media}
 * until the caller uploads them and substitutes the served URLs.
 */

export const MEDIA_URL_PREFIX = 'import-media:';
export const mediaUrl = (key: string) => `${MEDIA_URL_PREFIX}${key}`;
export const mediaKeyOf = (url: string): string | null => (url.startsWith(MEDIA_URL_PREFIX) ? url.slice(MEDIA_URL_PREFIX.length) : null);

export interface ImportedMedia {
  /** What elements refer to, unique within the deck. */
  key: string;
  /** A file name with a usable extension, as the upload will be named. */
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface ImportedSlide {
  /** Index into {@link ImportedDeck.layouts}; null for the deck's blank layout. */
  layout: number | null;
  background?: SlideBackground;
  hidden?: boolean;
  transition?: SlideTransition;
  /** In paint order; `z` is set from the position when applied. Elements with `placeholder` name an imported layout's placeholder id. */
  elements: SlideElement[];
  /** Speaker notes, a paragraph per entry. */
  notes: string[];
}

export interface ImportedLayout extends Omit<SlideLayout, 'id'> {
  /** The id the source gave it, which slides' placeholders refer to; the deck gets a new one. */
  sourceId?: string;
}

export type ImportSourceFormat = 'pptx' | 'odp' | 'pdf' | 'other';

export interface ImportedDeck {
  /** The file's name, for messages. */
  fileName: string;
  /** The presentation's title: its document title, else the file name without its extension. */
  title: string;
  format: ImportSourceFormat;
  size: SlideSize;
  /** Footer, slide number and date switches and texts. */
  settings: Partial<Omit<DeckSettings, 'size' | 'themeId'>>;
  /** Absent for a source with no theme: the deck keeps the default one. */
  theme?: Omit<Theme, 'id'>;
  /** The master's pieces; absent ones stay as they are. */
  master?: Partial<Omit<SlideMaster, 'id'>>;
  /** Absent for a source with no layouts: the deck keeps the defaults. */
  layouts?: ImportedLayout[];
  slides: ImportedSlide[];
  media: ImportedMedia[];
  report: ImportReport;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type ImportReportKind = 'approximated' | 'dropped';

export interface ImportReportItem {
  kind: ImportReportKind;
  /** What it was, in a sentence member can read: "Gradient fills". */
  feature: string;
  /** How it came in, or why it did not. */
  detail?: string;
  /** Slides it was found on, 1-based; empty for things about the deck itself. */
  slides: number[];
  /** How many times it happened. */
  count: number;
}

export interface ImportReport {
  items: ImportReportItem[];
}

/** Collects what an importer approximated or dropped, merging repeats of the same thing into one entry with its slides. */
export class ReportBuilder {
  private readonly byKey = new Map<string, ImportReportItem>();

  add(kind: ImportReportKind, feature: string, slide?: number | null, detail?: string): void {
    const key = `${kind}|${feature}`;
    let item = this.byKey.get(key);
    if (!item) {
      item = { kind, feature, ...(detail ? { detail } : {}), slides: [], count: 0 };
      this.byKey.set(key, item);
    }
    item.count += 1;
    if (slide && !item.slides.includes(slide)) item.slides.push(slide);
  }

  approximated(feature: string, slide?: number | null, detail?: string): void {
    this.add('approximated', feature, slide, detail);
  }

  dropped(feature: string, slide?: number | null, detail?: string): void {
    this.add('dropped', feature, slide, detail);
  }

  build(): ImportReport {
    const order = { dropped: 0, approximated: 1 };
    const items = [...this.byKey.values()].map((item) => ({ ...item, slides: [...item.slides].sort((a, b) => a - b) }));
    return { items: items.sort((a, b) => order[a.kind] - order[b.kind] || a.feature.localeCompare(b.feature)) };
  }
}

/** One line for a report item: "Gradient fills (3 times; slides 2, 5)". */
export function describeReportItem(item: ImportReportItem): string {
  const where = item.slides.length > 0 ? `slide${item.slides.length === 1 ? '' : 's'} ${summariseSlides(item.slides)}` : '';
  const times = item.count > 1 ? `${item.count} times` : '';
  const extra = [times, where].filter(Boolean).join('; ');
  return `${item.feature}${extra ? ` (${extra})` : ''}${item.detail ? `: ${item.detail}` : ''}`;
}

function summariseSlides(slides: number[]): string {
  return slides.length > 8 ? `${slides.slice(0, 8).join(', ')} and ${slides.length - 8} more` : slides.join(', ');
}

/** Progress an importer reports as it works, for a status line. */
export interface ImportProgress {
  stage: 'reading' | 'parsing' | 'uploading' | 'applying';
  done: number;
  total: number;
  message: string;
}

// --- which files are presentations to import -----------------------------

export const SLIDE_IMPORT_EXTENSIONS = ['.pptx', '.pptm', '.ppsx', '.potx', '.odp', '.otp'];
export const SLIDE_IMPORT_ACCEPT = [...SLIDE_IMPORT_EXTENSIONS, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.presentation'].join(',');

export function isSlideImportFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SLIDE_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- which files are presentation templates to import (PARA-110) ----------

export const TEMPLATE_IMPORT_EXTENSIONS = ['.potx', '.pptx', '.thmx'];
export const TEMPLATE_IMPORT_ACCEPT = [
  ...TEMPLATE_IMPORT_EXTENSIONS,
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-officetheme',
].join(',');

export function isTemplateImportFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEMPLATE_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A template's name from its file: the file name without its extension. */
export function templateNameOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, 100) || 'Imported template';
}
