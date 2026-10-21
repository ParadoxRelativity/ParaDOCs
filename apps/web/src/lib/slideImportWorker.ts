import { DOMParser } from '@xmldom/xmldom';
import type { SlideSize } from '@paradocs/shared';
import { parseSlideFile } from './slideImportParse';
import type { ShapeRasterizer } from './pptx';
import type { ImportProgress, ImportedDeck } from './slideImportTypes';

/**
 * Reads a presentation file off the page's thread, so a large deck does not
 * freeze the UI. A worker has no DOMParser, so the XML is parsed with xmldom
 * (the same DOM interface, in plain JavaScript).
 *
 * Messages in:  { data: ArrayBuffer, fileName, fitTo?, template? }
 * Messages out: { type: 'progress', progress } ... then { type: 'done', deck }
 *               or { type: 'error', message }
 */

export type SlideImportRequest = { data: ArrayBuffer; fileName: string; fitTo?: SlideSize; template?: boolean };
export type SlideImportResponse =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done'; deck: ImportedDeck }
  | { type: 'error'; message: string };

/** Draws a freeform shape to a PNG, which only a browser can. */
const rasterize: ShapeRasterizer = async (shape) => {
  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return null;
  const canvas = new OffscreenCanvas(shape.width, shape.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const path of shape.paths) {
    const sx = shape.width / path.w;
    const sy = shape.height / path.h;
    const p = new Path2D();
    for (const c of path.commands) {
      if (c[0] === 'M') p.moveTo(c[1] * sx, c[2] * sy);
      else if (c[0] === 'L') p.lineTo(c[1] * sx, c[2] * sy);
      else if (c[0] === 'C') p.bezierCurveTo(c[1] * sx, c[2] * sy, c[3] * sx, c[4] * sy, c[5] * sx, c[6] * sy);
      else p.closePath();
    }
    if (path.fill && shape.fill) {
      ctx.fillStyle = shape.fill;
      ctx.fill(p);
    }
    if (path.stroke && shape.stroke) {
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = Math.max(shape.strokeWidth, 1);
      ctx.stroke(p);
    }
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
};

const workerParseXml = (text: string): Document => new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;

const scope = self as unknown as {
  postMessage(message: SlideImportResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SlideImportRequest>) => void) | null;
};

// Only a worker answers messages; importing this file for its types must not.
if (typeof window === 'undefined') {
  scope.onmessage = async (event) => {
    try {
      const deck = await parseSlideFile(event.data.data, event.data.fileName, {
        parseXml: workerParseXml,
        rasterize,
        fitTo: event.data.fitTo,
        template: event.data.template,
        onProgress: (progress) => scope.postMessage({ type: 'progress', progress }),
      });
      // Hand the pictures over rather than copying them.
      const transfer = deck.media.map((m) => m.data.buffer).filter((b, i, all) => b instanceof ArrayBuffer && all.indexOf(b) === i) as ArrayBuffer[];
      scope.postMessage({ type: 'done', deck }, transfer);
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'Could not read that file' });
    }
  };
}
