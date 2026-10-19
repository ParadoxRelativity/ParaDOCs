import JSZip from 'jszip';
import { themeColor, type MappedColorSlot, type ThemeColorSlot } from '@paradocs/shared';

/**
 * The small toolkit the .pptx and .odp parsers share: reading a zip package,
 * walking XML by local name (so a file's choice of namespace prefixes does not
 * matter), relationships, and colors.
 *
 * Nothing here touches the browser. The XML parser is passed in: the page and
 * the tests use the platform's DOMParser or xmldom, a Web Worker (which has no
 * DOMParser) uses xmldom.
 */

export type XmlParser = (text: string) => Document;

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

export interface ZipFiles {
  names(): string[];
  text(path: string): Promise<string | null>;
  bytes(path: string): Promise<Uint8Array | null>;
}

export class PackageError extends Error {}

export async function openZip(data: ArrayBuffer | Uint8Array): Promise<ZipFiles> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new PackageError('That file is not a readable presentation (it is not a valid zip package).');
  }
  const find = (path: string) => zip.file(path.replace(/^\//, ''));
  return {
    names: () => Object.keys(zip.files).filter((name) => !zip.files[name].dir),
    text: async (path) => (await find(path)?.async('string')) ?? null,
    bytes: async (path) => (await find(path)?.async('uint8array')) ?? null,
  };
}

// ---------------------------------------------------------------------------
// XML by local name
// ---------------------------------------------------------------------------

export const localName = (node: Node): string => (node as Element).localName || node.nodeName.split(':').pop() || '';

/** Child elements, optionally only those with this local name. */
export function kids(el: Element | null | undefined, name?: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (name === undefined || localName(node) === name)) out.push(node as Element);
  }
  return out;
}

/** The first child along a path of local names: `child(sp, 'nvSpPr', 'nvPr')`. */
export function child(el: Element | null | undefined, ...path: string[]): Element | null {
  let current: Element | null | undefined = el;
  for (const name of path) {
    if (!current) return null;
    current = kids(current, name)[0];
  }
  return current ?? null;
}

/** Every descendant with this local name, in document order. */
export function descendants(el: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  const visit = (node: Element) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (localName(c) === name) out.push(c as Element);
      visit(c as Element);
    }
  };
  if (el) visit(el);
  return out;
}

/** An attribute by its local name, whatever its prefix (`embed` finds `r:embed`). */
export function attr(el: Element | null | undefined, name: string): string | undefined {
  if (!el) return undefined;
  const direct = el.getAttribute(name);
  if (direct !== null && direct !== '') return direct;
  const list = el.attributes;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if ((a.localName || a.name.split(':').pop()) === name) return a.value;
  }
  return direct ?? undefined;
}

export function numAttr(el: Element | null | undefined, name: string): number | undefined {
  const value = attr(el, name);
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function boolAttr(el: Element | null | undefined, name: string): boolean | undefined {
  const value = attr(el, name);
  if (value === undefined) return undefined;
  return value === '1' || value === 'true';
}

/** The text under an element, all descendants joined. */
export function textOf(el: Element | null | undefined): string {
  return el?.textContent ?? '';
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export interface Rel {
  id: string;
  /** The last segment of the relationship type: `slide`, `image`, `hyperlink`. */
  type: string;
  /** A path inside the package for an internal part, the address for an external one. */
  target: string;
  external: boolean;
}

/** Resolves `../media/a.png` against the part that names it. */
export function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

export function parseRels(doc: Document, part: string): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  for (const el of descendants(doc.documentElement, 'Relationship')) {
    const id = attr(el, 'Id');
    const target = attr(el, 'Target');
    if (!id || !target) continue;
    const external = attr(el, 'TargetMode') === 'External';
    rels.set(id, {
      id,
      type: (attr(el, 'Type') ?? '').split('/').pop() ?? '',
      target: external ? target : resolvePath(part, target),
      external,
    });
  }
  return rels;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  aac: 'audio/aac',
};

export const extensionOf = (path: string): string => (path.split('.').pop() ?? '').toLowerCase();
export const mimeOf = (path: string): string | null => MIME_BY_EXTENSION[extensionOf(path)] ?? null;
export const mediaKind = (mime: string): 'image' | 'video' | 'audio' => (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image');

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

const SCHEME_SLOTS: Record<string, ThemeColorSlot | MappedColorSlot> = {
  bg1: 'background1',
  tx1: 'text1',
  bg2: 'background2',
  tx2: 'text2',
  dk1: 'dark1',
  lt1: 'light1',
  dk2: 'dark2',
  lt2: 'light2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hyperlink',
  folHlink: 'followedHyperlink',
  tx: 'text1',
  bg: 'background1',
};

const PRESET_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  darkBlue: '#00008b',
  darkRed: '#8b0000',
  darkGreen: '#006400',
  lightGray: '#d3d3d3',
  lightGrey: '#d3d3d3',
  darkGray: '#a9a9a9',
  darkGrey: '#a9a9a9',
};

const SYSTEM_COLORS: Record<string, string> = { windowText: '#000000', window: '#ffffff' };

function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  let r = l;
  let g = l;
  let b = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const part = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export interface ResolvedColor {
  color: string;
  /** Transforms the model cannot hold, named for the report. */
  lost: string[];
  /** 0 to 1 when the color was translucent. */
  alpha?: number;
}

/**
 * An `a:srgbClr`, `a:schemeClr`, `a:sysClr` or `a:prstClr` as a color field.
 * Scheme colors stay theme slots (`theme:accent1`), with PowerPoint's
 * lumMod/lumOff pair as the lighter (+N) or darker (-N) steps of its palette;
 * literal colors take lumMod/lumOff exactly. `phClr` stands for the color of
 * whatever refers to the style and is given as `placeholder`.
 */
export function resolveColor(el: Element, placeholder?: string): ResolvedColor | null {
  const name = localName(el);
  const lost: string[] = [];
  let lumMod: number | undefined;
  let lumOff: number | undefined;
  let alpha: number | undefined;
  for (const t of kids(el)) {
    const tn = localName(t);
    const val = numAttr(t, 'val');
    if (tn === 'lumMod') lumMod = (val ?? 100000) / 1000;
    else if (tn === 'lumOff') lumOff = (val ?? 0) / 1000;
    else if (tn === 'alpha') alpha = (val ?? 100000) / 100000;
    else if (['tint', 'shade', 'satMod', 'satOff', 'hueMod', 'hueOff', 'comp', 'inv', 'gray', 'alphaMod', 'sat', 'lum'].includes(tn)) lost.push(tn);
  }
  if (alpha !== undefined && alpha >= 1) alpha = undefined;

  let base: string | null = null;
  let slot: string | null = null;
  if (name === 'srgbClr') base = `#${(attr(el, 'val') ?? '000000').slice(0, 6).toLowerCase()}`;
  else if (name === 'sysClr') {
    const last = attr(el, 'lastClr');
    base = last ? `#${last.toLowerCase()}` : (SYSTEM_COLORS[attr(el, 'val') ?? ''] ?? '#000000');
  }
  else if (name === 'prstClr') base = PRESET_COLORS[attr(el, 'val') ?? ''] ?? '#000000';
  else if (name === 'schemeClr') {
    const val = attr(el, 'val') ?? '';
    if (val === 'phClr') {
      if (!placeholder) return null;
      if (placeholder.startsWith('#')) base = placeholder;
      else slot = placeholder;
    } else slot = SCHEME_SLOTS[val] ?? null;
    if (!slot && !base) return null;
  } else return null;

  let color: string;
  if (base) {
    color = base;
    if (lumMod !== undefined || lumOff !== undefined) {
      const [h, s, l] = toHsl(base);
      color = fromHsl(h, s, Math.min(Math.max(l * ((lumMod ?? 100) / 100) + (lumOff ?? 0) / 100, 0), 1));
    }
  } else {
    // A placeholder color may already be a themed step; its own transforms stack no further than the model allows.
    const text = slot as string;
    const parsedBase = /^theme:([a-zA-Z0-9]+)$/.exec(text);
    const slotName = (parsedBase ? parsedBase[1] : text.replace(/^theme:/, '')) as ThemeColorSlot | MappedColorSlot;
    let adjust = 0;
    if (lumMod !== undefined && lumOff !== undefined) adjust = lumOff;
    else if (lumMod !== undefined) adjust = lumMod < 100 ? -(100 - lumMod) : lumMod - 100;
    else if (lumOff !== undefined) adjust = lumOff;
    color = themeColor(slotName, Math.round(adjust));
  }
  return { color, lost, ...(alpha !== undefined ? { alpha } : {}) };
}

/** The first color element among an element's children. */
export function firstColor(el: Element | null | undefined, placeholder?: string): ResolvedColor | null {
  for (const c of kids(el)) {
    const r = resolveColor(c, placeholder);
    if (r) return r;
  }
  return null;
}
