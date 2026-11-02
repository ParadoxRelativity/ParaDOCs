import { authHeaders, serverUrl } from './server';
import { isWindowsPicture } from './slideImportTypes';

/**
 * Windows metafile pictures (.emf, .wmf), which PowerPoint often uses for
 * charts, diagrams and pasted drawings and which no browser shows. The
 * importers keep them, and they are turned into PNGs on their way to the
 * upload:
 *
 * 1. by the server's converter (LibreOffice, docs/slides-converter.md), which
 *    reads every kind of metafile, when the server has one;
 * 2. otherwise in the browser, with rtf.js's EMF and WMF renderers, which draw
 *    most charts and drawings but miss some of the newer EMF+ effects.
 *
 * One that neither can read fails its upload, and the import report lists it.
 */

/** The longest side of the PNG made, in pixels. */
const MAX_SIDE = 2400;

export interface MetafileSize {
  /** The picture's size in the metafile's own units. */
  width: number;
  height: number;
  /** The PNG to make, in pixels: twice the picture's printed size at 96 dpi, within {@link MAX_SIDE}. */
  pixelWidth: number;
  pixelHeight: number;
}

function pixelsFor(widthInches: number, heightInches: number): { pixelWidth: number; pixelHeight: number } {
  const longest = Math.max(widthInches, heightInches) * 96 * 2;
  const scale = Math.min(1, MAX_SIDE / longest) * 96 * 2;
  return {
    pixelWidth: Math.max(1, Math.round(widthInches * scale)),
    pixelHeight: Math.max(1, Math.round(heightInches * scale)),
  };
}

/** A metafile's extent, from its header; null when the header does not say. */
export function metafileSize(data: Uint8Array, mimeType: string): MetafileSize | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimeType === 'image/emf') {
    // EMR_HEADER: the frame in hundredths of a millimetre, and the reference device in pixels and millimetres.
    if (data.byteLength < 88 || view.getUint32(0, true) !== 1) return null;
    const frame = [24, 28, 32, 36].map((at) => view.getInt32(at, true));
    const [devX, devY, mmX, mmY] = [72, 76, 80, 84].map((at) => view.getInt32(at, true));
    if (!(devX > 0 && devY > 0 && mmX > 0 && mmY > 0)) return null;
    const widthMm = (frame[2] - frame[0]) / 100;
    const heightMm = (frame[3] - frame[1]) / 100;
    if (!(widthMm > 0 && heightMm > 0)) return null;
    // Drawing happens in device units.
    const toDevX = devX / mmX / 100;
    const toDevY = devY / mmY / 100;
    return {
      width: widthMm * 100 * toDevX,
      height: heightMm * 100 * toDevY,
      ...pixelsFor(widthMm / 25.4, heightMm / 25.4),
    };
  }
  if (mimeType === 'image/wmf') {
    // Only a "placeable" WMF says how large it is: its bounding box, and how many units make an inch.
    if (data.byteLength < 22 || view.getUint32(0, true) !== 0x9ac6cdd7) return null;
    const [left, top, right, bottom] = [6, 8, 10, 12].map((at) => view.getInt16(at, true));
    const inch = view.getUint16(14, true);
    const width = right - left;
    const height = bottom - top;
    if (!(width > 0 && height > 0 && inch > 0)) return null;
    return { width, height, ...pixelsFor(width / inch, height / inch) };
  }
  return null;
}

/** Workspaces whose server has no converter (or none answering), so later pictures go straight to the browser. */
const noConverter = new Set<string>();

/**
 * Server conversions, one at a time. The converter works through pictures one
 * by one anyway, and the server turns away more than a couple at once as busy:
 * sent alongside each other (an import uploads three files at a time), some
 * were refused and went to the browser's renderer instead.
 */
let serverTurn: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = serverTurn.then(task, task);
  serverTurn = run.catch(() => undefined);
  return run;
}

/** How often a picture is offered again to a converter that says it is busy (another person importing). */
const BUSY_TRIES = 5;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's converter's PNG; null when there is no converter or it could not read this one. */
function convertOnServer(workspaceId: string, file: File, size: MetafileSize | null): Promise<Blob | null> {
  return inTurn(async () => {
    const query = size ? `?width=${size.pixelWidth}&height=${size.pixelHeight}` : '';
    for (let attempt = 1; ; attempt += 1) {
      if (noConverter.has(workspaceId)) return null;
      const body = new FormData();
      body.append('file', file);
      let res: Response;
      try {
        res = await fetch(serverUrl(`/api/workspaces/${workspaceId}/presentations/convert-picture${query}`), {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders(),
          body,
        });
      } catch {
        noConverter.add(workspaceId);
        return null;
      }
      if (res.ok) return await res.blob();
      await res.body?.cancel().catch(() => undefined);
      // No converter, or an older server without this route.
      if (res.status === 501 || res.status === 404) noConverter.add(workspaceId);
      if (res.status !== 503 || attempt >= BUSY_TRIES) return null;
      const after = Number(res.headers.get('retry-after'));
      await wait(Math.min(Number.isFinite(after) && after > 0 ? after : 2, 10) * 1000);
    }
  });
}

interface MetafileModule {
  Renderer: new (data: ArrayBuffer) => MetafileRenderer;
  loggingEnabled(enabled: boolean): void;
}

interface MetafileRenderer {
  render(info: { width: string; height: string; wExt?: number; hExt?: number; xExt: number; yExt: number; mapMode: number }): SVGElement;
  /** The parsed EMF, which rtf.js keeps private: what {@link scaleEmfPens} reaches its drawing context through. */
  _img?: { render(gdi: EmfDrawing): void };
}

/** The parts of rtf.js's EMF drawing context (its private GDIContext) that {@link scaleEmfPens} uses. */
interface EmfDrawing {
  /** The window (logical units) and viewport (device units) widths, whose ratio scales every point. */
  state: { vw: number; ww: number };
  _applyOpts(opts: Record<string, unknown> | null, usePen: boolean, useBrush: boolean, useFont: boolean): Record<string, unknown>;
}

const PENS_SCALED = Symbol('pens scaled');

/**
 * rtf.js's EMF renderer scales every point from the metafile's logical units
 * to device units, but writes each pen's width unscaled (its WMF renderer does
 * scale them). A metafile drawn at a tenth of its logical size then gets lines
 * ten times too thick: sheet music's staff lines merge into a black block.
 * This scales them as GDI does, at least one device pixel wide, a zero-width
 * ("cosmetic") pen being exactly one, and its dashes with it.
 *
 * The drawing context is not exported, so it is reached through the first
 * call that hands it one, and its class is patched once.
 */
function scaleEmfPens(renderer: MetafileRenderer): void {
  const img = renderer._img;
  if (!img) return;
  const render = img.render.bind(img);
  img.render = (gdi) => {
    const proto = Object.getPrototypeOf(gdi) as EmfDrawing & { [PENS_SCALED]?: true };
    if (!proto[PENS_SCALED] && typeof proto._applyOpts === 'function') {
      proto[PENS_SCALED] = true;
      const applyOpts = proto._applyOpts;
      proto._applyOpts = function (this: EmfDrawing, opts, usePen, useBrush, useFont) {
        const out = applyOpts.call(this, opts, usePen, useBrush, useFont);
        const raw = out['stroke-width'];
        if (!usePen || typeof raw !== 'number') return out;
        const scale = Math.abs(this.state.vw / this.state.ww) || 1;
        const width = Math.max(1, raw * scale);
        out['stroke-width'] = width;
        const dashes = out['stroke-dasharray'];
        if (typeof dashes === 'string' && raw > 0) {
          out['stroke-dasharray'] = dashes
            .split(',')
            .map((n) => (Number(n) * width) / raw)
            .join(',');
        }
        return out;
      };
    }
    render(gdi);
  };
}

/** rtf.js's renderer for this kind of metafile, loaded only when one is needed. */
async function loadRenderer(mimeType: string): Promise<MetafileModule['Renderer']> {
  const loaded = (
    mimeType === 'image/emf' ? await import('rtf.js/dist/EMFJS.bundle.min.js') : await import('rtf.js/dist/WMFJS.bundle.min.js')
    // Through unknown: the shape given here reaches the private parts scaleEmfPens needs.
  ) as unknown as Partial<MetafileModule> & {
    default?: MetafileModule;
  };
  const mod = loaded.Renderer ? (loaded as MetafileModule) : loaded.default;
  if (!mod?.Renderer) throw new Error('The metafile renderer did not load');
  // It logs every record it draws unless told not to.
  mod.loggingEnabled(false);
  return mod.Renderer;
}

/** The browser's own drawing of a metafile, as an SVG element. Throws when rtf.js cannot read it. */
export async function renderMetafileSvg(data: Uint8Array, mimeType: string, size: MetafileSize): Promise<SVGElement> {
  const Renderer = await loadRenderer(mimeType);
  const renderer = new Renderer(data.slice().buffer);
  if (mimeType === 'image/emf') scaleEmfPens(renderer);
  return renderer.render({
    width: `${size.pixelWidth}px`,
    height: `${size.pixelHeight}px`,
    // Window and viewport alike, so the drawing comes out at the metafile's own scale.
    wExt: size.width,
    hExt: size.height,
    xExt: size.width,
    yExt: size.height,
    mapMode: 8,
  });
}

/** The browser's own drawing of a metafile, as a PNG; null when it cannot read it. */
async function convertInBrowser(data: Uint8Array, mimeType: string, size: MetafileSize | null): Promise<Blob | null> {
  if (!size || typeof document === 'undefined') return null;
  let url: string | null = null;
  try {
    const svg = await renderMetafileSvg(data, mimeType, size);
    url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: 'image/svg+xml',
      }),
    );
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.pixelWidth;
    canvas.height = size.pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, size.pixelWidth, size.pixelHeight);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/** A metafile as a PNG, by the server's converter or else the browser. Throws when neither can read it. */
export async function convertWindowsPicture(workspaceId: string, file: File): Promise<File> {
  const data = new Uint8Array(await file.arrayBuffer());
  const size = metafileSize(data, file.type);
  const png = (await convertOnServer(workspaceId, file, size)) ?? (await convertInBrowser(data, file.type, size));
  if (!png) throw new Error(`Could not turn ${file.name} into a picture`);
  return new File([png], file.name.replace(/\.[^.]+$/, '') + '.png', {
    type: 'image/png',
  });
}

/** An import's upload step that first turns each metafile into a PNG; every other file goes up as it is. */
export function convertingWindowsPictures<T>(workspaceId: string, upload: (file: File) => Promise<T>): (file: File) => Promise<T> {
  return async (file) => upload(isWindowsPicture(file.type) ? await convertWindowsPicture(workspaceId, file) : file);
}
