import { PackageError, openZip, type XmlParser } from './ooxml';
import { parsePptx, parseThmx, type ShapeRasterizer } from './pptx';
import type { SlideSize } from '@paradocs/shared';
import type { ImportProgress, ImportedDeck } from './slideImportTypes';

export { SLIDE_IMPORT_ACCEPT, SLIDE_IMPORT_EXTENSIONS, isSlideImportFile } from './slideImportTypes';

/**
 * Reading a presentation file's bytes into an {@link ImportedDeck}, whichever
 * of the formats it is in. Pure: it needs an XML parser and nothing from the
 * browser, so it runs inside the import worker and directly under test.
 *
 * This is the one place every importer plugs in. PARA-96's converter returns
 * .pptx bytes for .ppt and Keynote files and hands them to this function; a PDF
 * importer builds an {@link ImportedDeck} of full-slide pictures itself and
 * goes straight to `applyImport`.
 */

export interface ParseOptions {
  parseXml: XmlParser;
  rasterize?: ShapeRasterizer;
  onProgress?: (progress: ImportProgress) => void;
  /** A .pptx's slides scaled to fit this size rather than keeping their own (see PptxOptions). */
  fitTo?: SlideSize;
  /** Only the look, for a presentation template: the file's slides are left out (see PptxOptions). */
  template?: boolean;
}

/** A PowerPoint theme file (.thmx) holds a theme part and no presentation. */
const THEME_PART = /^theme\/theme\/theme\d*\.xml$/;

export async function parseSlideFile(data: ArrayBuffer | Uint8Array, fileName: string, options: ParseOptions): Promise<ImportedDeck> {
  const zip = await openZip(data);
  const names = new Set(zip.names());
  if (!names.has('ppt/presentation.xml') && [...names].some((name) => THEME_PART.test(name))) {
    return parseThmx(zip, { parseXml: options.parseXml, fileName });
  }
  if (names.has('ppt/presentation.xml') || names.has('[Content_Types].xml')) {
    return parsePptx(zip, {
      parseXml: options.parseXml,
      fileName,
      rasterize: options.rasterize,
      onProgress: options.onProgress,
      fitTo: options.fitTo,
      template: options.template,
    });
  }
  if (names.has('content.xml') && names.has('mimetype')) {
    const { parseOdp } = await import('./odp');
    const deck = await parseOdp(zip, { parseXml: options.parseXml, fileName, onProgress: options.onProgress });
    return options.template ? { ...deck, slides: [] } : deck;
  }
  throw new PackageError('That file is not a PowerPoint (.pptx) or OpenDocument (.odp) presentation.');
}
