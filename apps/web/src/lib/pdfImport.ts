import { normalizeSlideSize, type SlideElement, type SlideSize } from '@paradocs/shared';
import { ReportBuilder, mediaUrl, type ImportProgress, type ImportedDeck, type ImportedMedia, type ImportedSlide } from './slideImportTypes';
import { randomId } from './util';

/**
 * Importing a PDF as a deck: one slide per page, each a full-slide picture of
 * the page. A producer of {@link ImportedDeck} like the .pptx and .odp parsers,
 * so the pictures are uploaded and the deck written exactly as theirs are.
 *
 * pdf.js reads the file and draws each page in the browser; nothing is sent
 * anywhere. It is loaded only when a PDF is imported, so opening Slides never
 * pays for it. This is also the way in for a deck that converts poorly: export
 * it to PDF and every page comes across looking as it did, at the cost of the
 * text no longer being editable.
 */

/** Pages past this are left out (and reported): each is a picture held in memory until uploaded. */
export const MAX_PDF_PAGES = 200;

/** The longer side, in pixels, pages are drawn at. A slide is 1920 wide, so this is as sharp as the stage ever shows. */
export const PDF_PAGE_LONG_EDGE = 1920;

/** The longer side of the deck's slide size, in its own units; the shorter follows the first page's shape. */
const SLIDE_LONG_EDGE = 1920;

/** A page picture above this size is re-encoded smaller; pictures of text compress well as PNG, photographs do not. */
const PREFERRED_PNG_BYTES = 1_500_000;

export interface PdfPageImage {
  /** The page's size in PDF points, which gives its shape. */
  width: number;
  height: number;
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

/** Draws page `pageNumber` (1-based) as a picture of at most `maxBytes`. */
export type PdfPageRenderer = (pageNumber: number, maxBytes: number) => Promise<PdfPageImage>;

/** What the rest of this file needs of pdf.js, so tests can stand in for the browser's drawing half. */
export interface PdfDocumentLike {
  numPages: number;
  render: PdfPageRenderer;
  destroy: () => Promise<void> | void;
}

export type PdfLoader = (data: Uint8Array) => Promise<PdfDocumentLike>;

export const isPdfFile = (name: string): boolean => name.toLowerCase().endsWith('.pdf');

/** The slide size for a deck whose first page has this shape: the longer side is 1920. */
export function slideSizeForPage(width: number, height: number): SlideSize {
  if (!(width > 0) || !(height > 0)) return { width: 1920, height: 1080 };
  const scale = SLIDE_LONG_EDGE / Math.max(width, height);
  return normalizeSlideSize({ width: Math.round(width * scale), height: Math.round(height * scale) });
}

/**
 * The deck of pictures. A page of the first page's shape fills its slide; a
 * page of another shape is shown whole, centred, on a white slide.
 */
export function buildPdfDeck(fileName: string, pages: PdfPageImage[], omitted = 0): ImportedDeck {
  const report = new ReportBuilder();
  const size = pages.length > 0 ? slideSizeForPage(pages[0].width, pages[0].height) : { width: 1920, height: 1080 };
  const media: ImportedMedia[] = [];
  const slides = pages.map((page, index): ImportedSlide => {
    const key = `pdf-page-${index + 1}`;
    media.push({ key, name: `page-${index + 1}.${page.mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType: page.mimeType, data: page.data });
    const fit = Math.min(size.width / page.width, size.height / page.height);
    const width = Math.round(page.width * fit);
    const height = Math.round(page.height * fit);
    if (Math.abs(width - size.width) > 2 || Math.abs(height - size.height) > 2) report.approximated('Pages of a different shape', index + 1, 'shown whole on a white slide');
    const element = {
      id: randomId(),
      type: 'image',
      url: mediaUrl(key),
      x: Math.round((size.width - width) / 2),
      y: Math.round((size.height - height) / 2),
      width,
      height,
      z: 1,
      fit: 'contain',
      alt: `Page ${index + 1} of ${fileName}`,
    } as unknown as SlideElement;
    return { layout: null, background: { kind: 'color', color: '#ffffff' }, elements: [element], notes: [] };
  });
  report.approximated('PDF pages', null, 'each page is a picture, so its text cannot be edited');
  if (omitted > 0) report.dropped('Pages beyond the limit', null, `only the first ${pages.length} of ${pages.length + omitted} pages were imported`);
  return {
    fileName,
    title: fileName.replace(/\.[^.]+$/, '') || 'Imported PDF',
    format: 'pdf',
    size,
    settings: {},
    slides,
    media,
    report: report.build(),
  };
}

/** A message a person can act on for what pdf.js threw. */
function explain(err: unknown): Error {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'PasswordException') return new Error('That PDF is password protected. Remove the password and try again.');
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'MissingPDFException') return new Error('That file is not a valid PDF.');
  return err instanceof Error ? err : new Error('Could not read that PDF');
}

export interface PdfImportOptions {
  onProgress?: (progress: ImportProgress) => void;
  /** The server's upload limit: a page picture is made smaller until it fits. */
  maxBytes?: number;
  /** For tests; the default is pdf.js drawing on a canvas. */
  load?: PdfLoader;
}

export async function importPdfFile(file: File, options: PdfImportOptions = {}): Promise<ImportedDeck> {
  const { onProgress, maxBytes = Infinity, load = loadWithPdfJs } = options;
  onProgress?.({ stage: 'reading', done: 0, total: 1, message: `Opening ${file.name}` });
  const data = new Uint8Array(await file.arrayBuffer());
  let doc: PdfDocumentLike;
  try {
    doc = await load(data);
  } catch (err) {
    throw explain(err);
  }
  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    if (total === 0) throw new Error('That PDF has no pages.');
    const pages: PdfPageImage[] = [];
    for (let n = 1; n <= total; n += 1) {
      onProgress?.({ stage: 'parsing', done: n - 1, total, message: `Drawing page ${n} of ${total}` });
      pages.push(await doc.render(n, maxBytes));
    }
    return buildPdfDeck(file.name, pages, doc.numPages - total);
  } catch (err) {
    throw explain(err);
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// pdf.js
// ---------------------------------------------------------------------------

async function loadWithPdfJs(data: Uint8Array): Promise<PdfDocumentLike> {
  // Both are separate chunks, fetched when someone imports a PDF.
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data }).promise;
  return {
    numPages: doc.numPages,
    destroy: () => doc.destroy(),
    render: async (pageNumber, maxBytes) => {
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        let scale = PDF_PAGE_LONG_EDGE / Math.max(base.width, base.height);
        for (let attempt = 0; ; attempt += 1) {
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('This browser cannot draw PDF pages.');
          // Pages are transparent until drawn on; a slide picture should be white paper.
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
          let image = await encode(canvas, 'image/png');
          if (image.size > PREFERRED_PNG_BYTES) {
            const jpeg = await encode(canvas, 'image/jpeg', 0.85);
            if (jpeg.size < image.size) image = jpeg;
          }
          // Release the bitmap now: a long PDF would otherwise hold a canvas per page.
          canvas.width = 0;
          canvas.height = 0;
          if (image.size <= maxBytes || attempt >= 3) {
            return { width: base.width, height: base.height, data: new Uint8Array(await image.arrayBuffer()), mimeType: image.type as PdfPageImage['mimeType'] };
          }
          scale *= 0.7;
        }
      } finally {
        page.cleanup();
      }
    },
  };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw that page'))), type, quality));
}
