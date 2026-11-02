// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { metafileSize, renderMetafileSvg } from '../src/lib/windowsPictures';

vi.mock('../src/lib/server', () => ({ serverUrl: (path: string) => path, authHeaders: () => ({}) }));

/**
 * The browser's drawing of an EMF: rtf.js's renderer, with its pen widths
 * scaled as GDI scales them. The metafile is built here, record by record,
 * the way music notation programs write one: a large logical window drawn
 * into a small viewport, so every coordinate and pen width shrinks.
 */
function emf(pens: { style?: number; width: number }[], window = 10_000, viewport = 1_000): Uint8Array {
  const records: number[][] = [];
  const record = (type: number, ...values: number[]) => records.push([type, 8 + values.length * 4, ...values]);
  record(17, 8); // EMR_SETMAPMODE: MM_ANISOTROPIC
  record(9, window, window); // EMR_SETWINDOWEXTEX
  record(11, viewport, viewport); // EMR_SETVIEWPORTEXTEX
  pens.forEach((pen, i) => {
    const y = 1000 + i * 200;
    record(38, i + 1, pen.style ?? 0, pen.width, 0, 0); // EMR_CREATEPEN: handle, style, width (x, y), black
    record(37, i + 1); // EMR_SELECTOBJECT
    record(27, 0, y); // EMR_MOVETOEX
    record(54, window, y); // EMR_LINETO
  });
  record(14, 0, 16, 20); // EMR_EOF

  const header = 88;
  const total = header + records.reduce((sum, r) => sum + r[1], 0);
  const data = new Uint8Array(total);
  const view = new DataView(data.buffer);
  const header32 = [1, header, 0, 0, viewport, viewport, 0, 0, 26_458, 26_458, 0x464d4520, 0x10000, total, records.length + 1, pens.length + 1, 0, 0, 0, 1000, 1000, 265, 265];
  header32.forEach((v, i) => view.setUint32(i * 4, v, true));
  view.setUint16(56, pens.length + 1, true); // nHandles is 16 bits, then 16 reserved
  view.setUint16(58, 0, true);
  let at = header;
  for (const r of records) {
    r.forEach((v, i) => view.setInt32(at + i * 4, v, true));
    at += r[1];
  }
  return data;
}

async function strokeWidths(data: Uint8Array): Promise<string[]> {
  const size = metafileSize(data, 'image/emf')!;
  const svg = await renderMetafileSvg(data, 'image/emf', size);
  return [...svg.querySelectorAll('[stroke-width]')].map((el) => el.getAttribute('stroke-width')!);
}

describe('renderMetafileSvg', () => {
  it('scales pen widths with the drawing, so close lines stay apart', async () => {
    // Staff lines 200 logical units apart, drawn with 13-unit pens, at a tenth of the size: 1.3 wide, 20 apart.
    const widths = await strokeWidths(emf([{ width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }]));
    expect(widths).toEqual(['1.3', '1.3', '1.3', '1.3', '1.3']);
  });

  it('draws a zero-width pen, and one thinner than a pixel, one device pixel wide', async () => {
    expect(await strokeWidths(emf([{ width: 0 }, { width: 4 }]))).toEqual(['1', '1']);
  });

  it('scales a dashed pen’s dashes with its width', async () => {
    const size = metafileSize(emf([{ style: 1, width: 30 }]), 'image/emf')!;
    const svg = await renderMetafileSvg(emf([{ style: 1, width: 30 }]), 'image/emf', size);
    const line = svg.querySelector('[stroke-dasharray]')!;
    expect(line.getAttribute('stroke-width')).toBe('3');
    expect(line.getAttribute('stroke-dasharray')).toBe('12,6');
  });

  it('leaves a drawing at its own scale as it was', async () => {
    expect(await strokeWidths(emf([{ width: 3 }], 1_000, 1_000))).toEqual(['3']);
  });
});
