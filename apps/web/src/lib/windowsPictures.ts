import { authHeaders, serverUrl } from "./server";
import { isWindowsPicture } from "./slideImportTypes";

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

function pixelsFor(
  widthInches: number,
  heightInches: number,
): { pixelWidth: number; pixelHeight: number } {
  const longest = Math.max(widthInches, heightInches) * 96 * 2;
  const scale = Math.min(1, MAX_SIDE / longest) * 96 * 2;
  return {
    pixelWidth: Math.max(1, Math.round(widthInches * scale)),
    pixelHeight: Math.max(1, Math.round(heightInches * scale)),
  };
}

/** A metafile's extent, from its header; null when the header does not say. */
export function metafileSize(
  data: Uint8Array,
  mimeType: string,
): MetafileSize | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimeType === "image/emf") {
    // EMR_HEADER: the frame in hundredths of a millimetre, and the reference device in pixels and millimetres.
    if (data.byteLength < 88 || view.getUint32(0, true) !== 1) return null;
    const frame = [24, 28, 32, 36].map((at) => view.getInt32(at, true));
    const [devX, devY, mmX, mmY] = [72, 76, 80, 84].map((at) =>
      view.getInt32(at, true),
    );
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
  if (mimeType === "image/wmf") {
    // Only a "placeable" WMF says how large it is: its bounding box, and how many units make an inch.
    if (data.byteLength < 22 || view.getUint32(0, true) !== 0x9ac6cdd7)
      return null;
    const [left, top, right, bottom] = [6, 8, 10, 12].map((at) =>
      view.getInt16(at, true),
    );
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

/** The server's converter's PNG; null when there is no converter or it could not read this one. */
async function convertOnServer(
  workspaceId: string,
  file: File,
  size: MetafileSize | null,
): Promise<Blob | null> {
  if (noConverter.has(workspaceId)) return null;
  const body = new FormData();
  body.append("file", file);
  const query = size
    ? `?width=${size.pixelWidth}&height=${size.pixelHeight}`
    : "";
  try {
    const res = await fetch(
      serverUrl(
        `/api/workspaces/${workspaceId}/presentations/convert-picture${query}`,
      ),
      {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body,
      },
    );
    if (res.ok) return await res.blob();
    // No converter, or an older server without this route.
    if (res.status === 501 || res.status === 404) noConverter.add(workspaceId);
    else await res.body?.cancel().catch(() => undefined);
    return null;
  } catch {
    noConverter.add(workspaceId);
    return null;
  }
}

interface MetafileModule {
  Renderer: new (data: ArrayBuffer) => MetafileRenderer;
  loggingEnabled(enabled: boolean): void;
}

interface MetafileRenderer {
  render(info: {
    width: string;
    height: string;
    wExt?: number;
    hExt?: number;
    xExt: number;
    yExt: number;
    mapMode: number;
  }): SVGElement;
}

/** rtf.js's renderer for this kind of metafile, loaded only when one is needed. */
async function loadRenderer(
  mimeType: string,
): Promise<MetafileModule["Renderer"]> {
  const loaded = (
    mimeType === "image/emf"
      ? await import("rtf.js/dist/EMFJS.bundle.min.js")
      : await import("rtf.js/dist/WMFJS.bundle.min.js")
  ) as Partial<MetafileModule> & {
    default?: MetafileModule;
  };
  const mod = loaded.Renderer ? (loaded as MetafileModule) : loaded.default;
  if (!mod?.Renderer) throw new Error("The metafile renderer did not load");
  // It logs every record it draws unless told not to.
  mod.loggingEnabled(false);
  return mod.Renderer;
}

/** The browser's own drawing of a metafile, as a PNG; null when it cannot read it. */
async function convertInBrowser(
  data: Uint8Array,
  mimeType: string,
  size: MetafileSize | null,
): Promise<Blob | null> {
  if (!size || typeof document === "undefined") return null;
  let url: string | null = null;
  try {
    const Renderer = await loadRenderer(mimeType);
    const copy = data.slice().buffer;
    const svg = new Renderer(copy).render({
      width: `${size.pixelWidth}px`,
      height: `${size.pixelHeight}px`,
      // Window and viewport alike, so the drawing comes out at the metafile's own scale.
      wExt: size.width,
      hExt: size.height,
      xExt: size.width,
      yExt: size.height,
      mapMode: 8,
    });
    url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size.pixelWidth;
    canvas.height = size.pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, size.pixelWidth, size.pixelHeight);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/** A metafile as a PNG, by the server's converter or else the browser. Throws when neither can read it. */
export async function convertWindowsPicture(
  workspaceId: string,
  file: File,
): Promise<File> {
  const data = new Uint8Array(await file.arrayBuffer());
  const size = metafileSize(data, file.type);
  const png =
    (await convertOnServer(workspaceId, file, size)) ??
    (await convertInBrowser(data, file.type, size));
  if (!png) throw new Error(`Could not turn ${file.name} into a picture`);
  return new File([png], file.name.replace(/\.[^.]+$/, "") + ".png", {
    type: "image/png",
  });
}

/** An import's upload step that first turns each metafile into a PNG; every other file goes up as it is. */
export function convertingWindowsPictures<T>(
  workspaceId: string,
  upload: (file: File) => Promise<T>,
): (file: File) => Promise<T> {
  return async (file) =>
    upload(
      isWindowsPicture(file.type)
        ? await convertWindowsPicture(workspaceId, file)
        : file,
    );
}
