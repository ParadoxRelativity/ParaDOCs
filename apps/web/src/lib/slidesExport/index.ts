import type { DeckSnapshot } from '@paradocs/shared';
import { api } from '../../api/client';
import { downloadBlob } from '../xlsx';

/**
 * Taking a deck out of ParaDOCs. Everything heavy (PptxGenJS, JSZip, the
 * XML writers) is imported only when someone exports, so opening a deck never
 * pays for it. Exporting reads the deck and what it shows as the person
 * exporting, so it needs no more than permission to view it.
 */

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** A file name made of a title: the characters filesystems refuse are dropped. */
export function exportFileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || 'Presentation'}.${extension}`;
}

/** The deck as the server last saved it or as people have it open now. Readable with `slides.view`. */
export function fetchDeckForExport(presentationId: string): Promise<DeckSnapshot> {
  return api.get<DeckSnapshot>(`/presentations/${presentationId}/deck`);
}

export interface PptxDownload {
  filename: string;
  /** What did not survive into the file, for the person to read. */
  report: string[];
}

/** Builds the .pptx in the browser and offers it as a download. */
export async function downloadPptx(deck: DeckSnapshot, title: string): Promise<PptxDownload> {
  const [{ buildPptx }, { browserAssets }] = await Promise.all([import('./pptx'), import('./assets')]);
  const { data, report } = await buildPptx(deck, { title, assets: browserAssets() });
  const filename = exportFileName(title, 'pptx');
  downloadBlob(new Blob([data as BlobPart], { type: PPTX_MIME }), filename);
  return { filename, report };
}
