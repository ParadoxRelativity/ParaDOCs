import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { readDeck } from '@paradocs/shared';
import { applyImport, resolveMedia, uploadImportMedia } from '../src/lib/slideImport';
import { MAX_PDF_PAGES, buildPdfDeck, importPdfFile, isPdfFile, slideSizeForPage, type PdfDocumentLike, type PdfLoader, type PdfPageImage } from '../src/lib/pdfImport';
import { describeReportItem } from '../src/lib/slideImportTypes';
import { fixturePath } from './helpers';

/** PDF import, and the choosing between importers for older formats. */

/** A stand-in for the browser's drawing half: pdf.js reads the real fixture, and a page "renders" to a few bytes of its own size. */
const readWithPdfJs: PdfLoader = async (data) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  return {
    numPages: doc.numPages,
    destroy: () => doc.destroy(),
    render: async (pageNumber): Promise<PdfPageImage> => {
      const page = await doc.getPage(pageNumber);
      const view = page.getViewport({ scale: 1 });
      return { width: view.width, height: view.height, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, pageNumber]), mimeType: 'image/png' };
    },
  };
};

const fixture = () => {
  const bytes = readFileSync(fixturePath('handout.pdf'));
  return new File([new Uint8Array(bytes)], 'handout.pdf', { type: 'application/pdf' });
};

describe('PDF import', () => {
  it('makes one full-slide picture per page, at the first page shape', async () => {
    const deck = await importPdfFile(fixture(), { load: readWithPdfJs });
    expect(deck.format).toBe('pdf');
    expect(deck.title).toBe('handout');
    expect(deck.size).toEqual({ width: 1920, height: 1080 });
    expect(deck.slides).toHaveLength(3);
    expect(deck.media.map((m) => m.name)).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);

    const [first, second] = deck.slides;
    expect(first.layout).toBeNull();
    expect(first.elements).toHaveLength(1);
    expect(first.elements[0]).toMatchObject({ type: 'image', x: 0, y: 0, width: 1920, height: 1080, url: 'import-media:pdf-page-1' });
    expect(second.elements[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('shows a page of another shape whole, centred, and says so in the report', async () => {
    const deck = await importPdfFile(fixture(), { load: readWithPdfJs });
    const portrait = deck.slides[2].elements[0];
    expect(portrait.height).toBe(1080);
    expect(portrait.width).toBe(Math.round((612 / 792) * 1080));
    expect(portrait.x).toBe(Math.round((1920 - portrait.width) / 2));
    const features = deck.report.items.map((i) => i.feature);
    expect(features).toContain('Pages of a different shape');
    expect(features).toContain('PDF pages');
    const shape = deck.report.items.find((i) => i.feature === 'Pages of a different shape')!;
    expect(shape.slides).toEqual([3]);
    expect(describeReportItem(shape)).toContain('slide 3');
  });

  it('sizes the deck to a portrait first page, and falls back for nonsense', () => {
    expect(slideSizeForPage(612, 792)).toEqual({ width: 1484, height: 1920 });
    expect(slideSizeForPage(0, 0)).toEqual({ width: 1920, height: 1080 });
  });

  it('reports progress page by page', async () => {
    const messages: string[] = [];
    await importPdfFile(fixture(), { load: readWithPdfJs, onProgress: (p) => messages.push(p.message) });
    expect(messages).toEqual(['Opening handout.pdf', 'Drawing page 1 of 3', 'Drawing page 2 of 3', 'Drawing page 3 of 3']);
  });

  it('turns pdf.js failures into messages a person can act on', async () => {
    const reject = (name: string): PdfLoader => async () => {
      throw Object.assign(new Error('internal'), { name });
    };
    await expect(importPdfFile(fixture(), { load: reject('PasswordException') })).rejects.toThrow(/password/i);
    await expect(importPdfFile(fixture(), { load: reject('InvalidPDFException') })).rejects.toThrow(/not a valid PDF/);
    const junk = new File([new TextEncoder().encode('this is not a pdf')], 'junk.pdf');
    await expect(importPdfFile(junk, { load: readWithPdfJs })).rejects.toThrow(/not a valid PDF/);
  });

  it('leaves out pages beyond the limit and says so', async () => {
    const destroyed = vi.fn();
    const huge: PdfDocumentLike = {
      numPages: MAX_PDF_PAGES + 5,
      destroy: destroyed,
      render: async () => ({ width: 960, height: 540, data: new Uint8Array([1]), mimeType: 'image/jpeg' }),
    };
    const deck = await importPdfFile(fixture(), { load: async () => huge });
    expect(deck.slides).toHaveLength(MAX_PDF_PAGES);
    expect(deck.media[0].name).toBe('page-1.jpg');
    expect(deck.report.items.find((i) => i.feature === 'Pages beyond the limit')?.kind).toBe('dropped');
    expect(destroyed).toHaveBeenCalled();
  });

  it('hands the render the upload limit, so pictures fit what can be uploaded', async () => {
    const seen: number[] = [];
    const doc: PdfDocumentLike = {
      numPages: 1,
      destroy: () => undefined,
      render: async (_n, maxBytes) => {
        seen.push(maxBytes);
        return { width: 960, height: 540, data: new Uint8Array([1]), mimeType: 'image/png' };
      },
    };
    await importPdfFile(fixture(), { load: async () => doc, maxBytes: 25 * 1024 * 1024 });
    expect(seen).toEqual([25 * 1024 * 1024]);
  });

  it('goes through the same upload and apply steps as a .pptx: pictures uploaded against the presentation, one slide each', async () => {
    const deck = buildPdfDeck('handout.pdf', [
      { width: 960, height: 540, data: new Uint8Array([1]), mimeType: 'image/png' },
      { width: 960, height: 540, data: new Uint8Array([2]), mimeType: 'image/png' },
    ]);
    const uploaded: string[] = [];
    const { urls, failed } = await uploadImportMedia(deck, async (file) => {
      uploaded.push(file.name);
      return { url: `/uploads/${file.name}` };
    });
    expect(failed).toEqual([]);
    expect(uploaded.sort()).toEqual(['page-1.png', 'page-2.png']);

    const ydoc = new Y.Doc();
    applyImport(ydoc, resolveMedia(deck, urls, failed));
    const slides = readDeck(ydoc).slides;
    expect(slides).toHaveLength(2);
    expect(slides[1].elements[0]).toMatchObject({ type: 'image', url: '/uploads/page-2.png', width: 1920, height: 1080 });
    expect(slides[0].background).toMatchObject({ kind: 'color', color: '#ffffff' });
  });

  it('recognises PDFs by extension', () => {
    expect(isPdfFile('Deck.PDF')).toBe(true);
    expect(isPdfFile('deck.pptx')).toBe(false);
  });
});

describe('older formats', () => {
  // The web client's server module reads window at import, as it does in a browser.
  beforeAll(() => {
    vi.stubGlobal('window', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {});
  });

  it('chooses the importer by extension', async () => {
    const { classifyImportFile, isKeynoteFile, ALL_IMPORT_ACCEPT } = await import('../src/lib/slideConvert');
    for (const name of ['a.pptx', 'a.ODP', 'a.potx']) expect(classifyImportFile(name)).toBe('native');
    for (const name of ['a.ppt', 'a.PPS', 'a.pot', 'a.key']) expect(classifyImportFile(name)).toBe('legacy');
    expect(classifyImportFile('handout.pdf')).toBe('pdf');
    expect(classifyImportFile('notes.docx')).toBeNull();
    expect(isKeynoteFile('Talk.KEY')).toBe(true);
    expect(isKeynoteFile('Talk.ppt')).toBe(false);
    for (const ext of ['.ppt', '.key', '.pdf', '.pptx', '.odp']) expect(ALL_IMPORT_ACCEPT).toContain(ext);
  });

  it('sends a legacy file to the server and returns the .pptx it answers with', async () => {
    const { convertLegacyFile } = await import('../src/lib/slideConvert');
    const calls: { url: string; body: FormData }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: FormData }) => {
      calls.push({ url, body: init.body });
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
    });
    const converted = await convertLegacyFile('ws-1', new File(['legacy'], 'Old Deck.ppt'));
    expect(calls[0].url).toContain('/api/workspaces/ws-1/presentations/convert');
    expect((calls[0].body.get('file') as File).name).toBe('Old Deck.ppt');
    expect(converted.name).toBe('Old Deck.pptx');
    expect(converted.size).toBe(4);
  });

  it('says the format needs a converter when the server has none, and passes other failures on', async () => {
    const { convertLegacyFile, ConverterUnavailableError } = await import('../src/lib/slideConvert');
    const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));
    reply(501, { error: 'no converter', code: 'converter_disabled' });
    await expect(convertLegacyFile('ws-1', new File(['x'], 'a.ppt'))).rejects.toBeInstanceOf(ConverterUnavailableError);
    reply(422, { error: 'The converter could not read that file.', code: 'conversion_failed' });
    await expect(convertLegacyFile('ws-1', new File(['x'], 'a.key'))).rejects.toThrow('could not read that file');
    reply(504, { error: 'Converting that file took too long', code: 'conversion_timeout' });
    await expect(convertLegacyFile('ws-1', new File(['x'], 'a.ppt'))).rejects.toThrow('took too long');
  });
});
