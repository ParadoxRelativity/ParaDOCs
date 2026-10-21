import {
  DEFAULT_COLOR_MAP,
  MASTER_ID,
  MAX_TEXT_COLUMNS,
  mapOfficeFont,
  normalizeTheme,
  themeColor,
  type ColorMap,
  type ElementAnimation,
  type GradientStop,
  type LayoutPlaceholder,
  type MasterPlaceholder,
  type PlaceholderKind,
  type PlaceholderStyle,
  type RichParagraph,
  type SlideBackground,
  type SlideElement,
  type SlideShapeKind,
  type SlideSize,
  type SlideTransition,
  type TableCell,
  type Theme,
  type ThemeColorSlot,
} from '@paradocs/shared';
import {
  PackageError,
  attr,
  boolAttr,
  child,
  descendants,
  extensionOf,
  firstColor,
  kids,
  localName,
  mediaKind,
  mimeOf,
  numAttr,
  parseRels,
  relId,
  relsPathOf,
  resolveColor,
  type Rel,
  type XmlParser,
  type ZipFiles,
} from './ooxml';
import { levelStyle, paragraphsHaveText, plainParagraphs, readParagraphs, type TextOptions, type TextScope, concreteColor } from './pptxText';
import { parseTiming } from './pptxTiming';
import { ReportBuilder, mediaUrl, type ImportProgress, type ImportedDeck, type ImportedLayout, type ImportedMedia, type ImportedSlide } from './slideImportTypes';
import { randomId } from './util';

/**
 * PowerPoint (.pptx, PresentationML) into an {@link ImportedDeck}.
 *
 * This file is pure: it reads a zip through the {@link ZipFiles} it is given
 * and parses XML with the {@link XmlParser} it is given, so it runs in a Web
 * Worker (lib/slideImportWorker.ts) in the app and straight on bytes in tests.
 *
 * What a .pptx calls what: a presentation has one or more slide masters, each
 * with layouts; slides sit on a layout, and a shape on a slide that is a
 * placeholder (`p:ph`) takes its position and text style from the matching
 * placeholder of the layout, which takes them from the master. The model here
 * has the same chain, so placeholders are imported as placeholders and a slide
 * writes a position or a style only where it differs from what it inherits.
 */

export interface ShapeRaster {
  /** Pixel size to draw at. */
  width: number;
  height: number;
  paths: { w: number; h: number; commands: PathCommand[]; fill: boolean; stroke: boolean }[];
  fill?: string;
  stroke?: string;
  strokeWidth: number;
}
export type PathCommand = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
/** Draws a custom shape to a PNG; only a browser can, so tests and other hosts may omit it. */
export type ShapeRasterizer = (shape: ShapeRaster) => Promise<Uint8Array | null>;

export interface PptxOptions {
  parseXml: XmlParser;
  fileName: string;
  rasterize?: ShapeRasterizer;
  onProgress?: (progress: ImportProgress) => void;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

interface Part {
  path: string;
  root: Element;
  rels: Map<string, Rel>;
}

/** The slide master's placeholder text and styles, which layouts and slides inherit. */
interface MasterInfo {
  part: Part;
  clrMap: ColorMap;
  placeholders: MasterPlaceholder[];
  /** The master's `p:ph` shapes by kind, for their own `a:lstStyle`. */
  lst: Map<string, Element | null>;
  titleStyle: Element | null;
  bodyStyle: Element | null;
  otherStyle: Element | null;
}

interface PhDef {
  type: string;
  idx?: string;
  kind: PlaceholderKind;
  id: string;
  lst: Element | null;
}

interface LayoutInfo {
  part: Part;
  name: string;
  layoutType?: string;
  phs: PhDef[];
  layout: ImportedLayout;
}

interface Affine {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}
const IDENTITY: Affine = { sx: 1, sy: 1, dx: 0, dy: 0 };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Shared {
  zip: ZipFiles;
  parseXml: XmlParser;
  report: ReportBuilder;
  size: SlideSize;
  k: number;
  theme: Theme;
  defaultFontSize: number;
  rasterize?: ShapeRasterizer;
  media: ImportedMedia[];
  mediaByPath: Map<string, string | null>;
  master: MasterInfo;
}

interface Scope {
  shared: Shared;
  part: Part;
  kind: 'slide' | 'layout' | 'master' | 'diagram';
  slideNo: number;
  layout?: LayoutInfo;
  spids: Map<string, string[]>;
  chrome?: { footerText?: string; dateText?: string; showFooter?: boolean; showSlideNumber?: boolean; showDate?: boolean };
  /** Warn about each unsupported thing once per slide, not once per shape. */
  text: TextScope;
}

const emu = (shared: Shared, value: number) => Math.round(value * shared.k);
const ptUnits = (shared: Shared, hundredths: number) => Math.round((hundredths / 100) * 12700 * shared.k * 10) / 10;

async function loadPart(shared: Pick<Shared, 'zip' | 'parseXml'>, path: string): Promise<Part | null> {
  const text = await shared.zip.text(path);
  if (!text) return null;
  const root = shared.parseXml(text).documentElement;
  const relsText = await shared.zip.text(relsPathOf(path));
  return { path, root, rels: relsText ? parseRels(shared.parseXml(relsText), path) : new Map() };
}

function relsOfType(part: Part, type: string): Rel[] {
  return [...part.rels.values()].filter((rel) => rel.type === type && !rel.external);
}

// ---------------------------------------------------------------------------
// Size, theme, colors
// ---------------------------------------------------------------------------

export function chooseSlideSize(cx: number, cy: number): { size: SlideSize; k: number } {
  const ratio = cx / cy;
  let size: SlideSize;
  if (Math.abs(ratio - 16 / 9) < 0.02) size = { width: 1920, height: 1080 };
  else if (Math.abs(ratio - 4 / 3) < 0.02) size = { width: 1440, height: 1080 };
  else if (ratio >= 1) size = { width: 1920, height: Math.max(160, Math.round((1920 * cy) / cx)) };
  else size = { width: Math.max(160, Math.round((1920 * cx) / cy)), height: 1920 };
  return { size, k: size.width / cx };
}

const THEME_SLOT_TAGS: [string, ThemeColorSlot][] = [
  ['dk1', 'dark1'],
  ['lt1', 'light1'],
  ['dk2', 'dark2'],
  ['lt2', 'light2'],
  ['accent1', 'accent1'],
  ['accent2', 'accent2'],
  ['accent3', 'accent3'],
  ['accent4', 'accent4'],
  ['accent5', 'accent5'],
  ['accent6', 'accent6'],
  ['hlink', 'hyperlink'],
  ['folHlink', 'followedHyperlink'],
];

function readTheme(root: Element | null, clrMap: ColorMap): Theme {
  const colors: Partial<Theme['colors']> = {};
  const scheme = child(root, 'themeElements', 'clrScheme');
  for (const [tag, slot] of THEME_SLOT_TAGS) {
    const color = firstColor(child(scheme, tag));
    // A theme's own colors are literal; `lumMod` on one cannot refer to itself.
    if (color && color.color.startsWith('#')) colors[slot] = color.color;
  }
  const fonts = child(root, 'themeElements', 'fontScheme');
  const major = attr(child(fonts, 'majorFont', 'latin'), 'typeface');
  const minor = attr(child(fonts, 'minorFont', 'latin'), 'typeface');
  return normalizeTheme({
    id: 'imported',
    name: attr(root, 'name') ?? 'Imported theme',
    colors: colors as Theme['colors'],
    fonts: { heading: mapOfficeFont(major), body: mapOfficeFont(minor) },
    colorMap: clrMap,
  });
}

function readColorMap(master: Element | null): ColorMap {
  const map = child(master, 'clrMap');
  const slot = (name: string, fallback: ThemeColorSlot): ThemeColorSlot => {
    const value = attr(map, name);
    const found = THEME_SLOT_TAGS.find(([tag]) => tag === value);
    return found ? found[1] : fallback;
  };
  return {
    background1: slot('bg1', DEFAULT_COLOR_MAP.background1),
    text1: slot('tx1', DEFAULT_COLOR_MAP.text1),
    background2: slot('bg2', DEFAULT_COLOR_MAP.background2),
    text2: slot('tx2', DEFAULT_COLOR_MAP.text2),
  };
}

/** A color element as a field value, noting what could not be kept. */
function colorValue(scope: Scope, el: Element | null | undefined, placeholder?: string): string | undefined {
  const color = firstColor(el, placeholder);
  if (!color) return undefined;
  const { report } = scope.shared;
  for (const lost of new Set(color.lost)) {
    if (lost === 'tint' || lost === 'shade') report.approximated('Tinted and shaded colors', scope.slideNo, 'drawn at full strength');
    else report.approximated('Color adjustments (saturation, hue)', scope.slideNo, 'the plain color is used');
  }
  if (color.alpha !== undefined) report.approximated('Transparent fills and lines', scope.slideNo, 'drawn solid');
  return color.color;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

async function addMedia(scope: Scope, path: string): Promise<string | null> {
  const { shared } = scope;
  const known = shared.mediaByPath.get(path);
  if (known !== undefined) return known;
  const mimeType = mimeOf(path);
  if (!mimeType) {
    shared.report.dropped(`Pictures and media in .${extensionOf(path) || 'unknown'} format`, scope.slideNo, 'the browser cannot show this format');
    shared.mediaByPath.set(path, null);
    return null;
  }
  const data = await shared.zip.bytes(path);
  if (!data) {
    shared.report.dropped('Pictures and media missing from the file', scope.slideNo);
    shared.mediaByPath.set(path, null);
    return null;
  }
  const key = `m${shared.media.length + 1}`;
  shared.media.push({ key, name: path.split('/').pop() ?? key, mimeType, data });
  const url = mediaUrl(key);
  shared.mediaByPath.set(path, url);
  return url;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Placed extends Box {
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

function readXfrm(scope: Scope, xfrm: Element | null, tf: Affine): Placed | null {
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  if (!off || !ext) return null;
  const { shared } = scope;
  const x = numAttr(off, 'x') ?? 0;
  const y = numAttr(off, 'y') ?? 0;
  const cx = numAttr(ext, 'cx') ?? 0;
  const cy = numAttr(ext, 'cy') ?? 0;
  return {
    x: emu(shared, tf.dx + tf.sx * x),
    y: emu(shared, tf.dy + tf.sy * y),
    width: emu(shared, tf.sx * cx),
    height: emu(shared, tf.sy * cy),
    rotation: ((numAttr(xfrm, 'rot') ?? 0) / 60000) % 360,
    flipH: boolAttr(xfrm, 'flipH') ?? false,
    flipV: boolAttr(xfrm, 'flipV') ?? false,
  };
}

function groupTransform(xfrm: Element | null, tf: Affine): Affine {
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  const chOff = child(xfrm, 'chOff');
  const chExt = child(xfrm, 'chExt');
  if (!off || !ext || !chOff || !chExt) return tf;
  const rx = (numAttr(chExt, 'cx') ?? 0) > 0 ? (numAttr(ext, 'cx') ?? 0) / (numAttr(chExt, 'cx') ?? 1) : 1;
  const ry = (numAttr(chExt, 'cy') ?? 0) > 0 ? (numAttr(ext, 'cy') ?? 0) / (numAttr(chExt, 'cy') ?? 1) : 1;
  return {
    sx: tf.sx * rx,
    sy: tf.sy * ry,
    dx: tf.dx + tf.sx * ((numAttr(off, 'x') ?? 0) - (numAttr(chOff, 'x') ?? 0) * rx),
    dy: tf.dy + tf.sy * ((numAttr(off, 'y') ?? 0) - (numAttr(chOff, 'y') ?? 0) * ry),
  };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const sameBox = (a: Box, b: Box) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

// ---------------------------------------------------------------------------
// Fills and lines
// ---------------------------------------------------------------------------

interface Paint {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: 'solid' | 'dashed' | 'dotted';
  shadow?: boolean;
  /** The color the style says text in the shape should be. */
  textColor?: string;
}

/** The color a fill element stands for; a gradient is the color nearest its middle, and says so. */
function fillColor(scope: Scope, fillEl: Element, phColor?: string): string | undefined {
  const name = localName(fillEl);
  if (name === 'solidFill') return colorValue(scope, fillEl, phColor);
  if (name === 'gradFill') {
    scope.shared.report.approximated('Gradient fills in shapes', scope.slideNo, 'the middle color is used');
    const stops = kids(child(fillEl, 'gsLst'), 'gs');
    let best: Element | null = null;
    for (const stop of stops) if (!best || Math.abs((numAttr(stop, 'pos') ?? 0) - 50000) < Math.abs((numAttr(best, 'pos') ?? 0) - 50000)) best = stop;
    return colorValue(scope, best, phColor);
  }
  if (name === 'pattFill') {
    scope.shared.report.approximated('Pattern fills', scope.slideNo, 'the foreground color is used');
    return colorValue(scope, child(fillEl, 'fgClr'), phColor);
  }
  if (name === 'blipFill') {
    scope.shared.report.dropped('Picture fills in shapes', scope.slideNo);
    return undefined;
  }
  return undefined;
}

const FILL_TAGS = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'];

function readPaint(scope: Scope, spPr: Element | null, style: Element | null): Paint {
  const paint: Paint = {};
  const fillRef = child(style, 'fillRef');
  const lnRef = child(style, 'lnRef');
  const fontRef = child(style, 'fontRef');

  const fillEl = kids(spPr).find((c) => FILL_TAGS.includes(localName(c)));
  if (fillEl) {
    if (localName(fillEl) === 'noFill') paint.fill = 'transparent';
    else if (localName(fillEl) !== 'grpFill') paint.fill = fillColor(scope, fillEl) ?? undefined;
  } else if (fillRef && (numAttr(fillRef, 'idx') ?? 0) > 0) {
    paint.fill = colorValue(scope, fillRef);
  }

  const ln = child(spPr, 'ln');
  const lineFill = kids(ln).find((c) => ['noFill', 'solidFill', 'gradFill', 'pattFill'].includes(localName(c)));
  if (lineFill) {
    if (localName(lineFill) === 'noFill') paint.stroke = 'transparent';
    else paint.stroke = fillColor(scope, lineFill);
  } else if (lnRef && (numAttr(lnRef, 'idx') ?? 0) > 0) {
    paint.stroke = colorValue(scope, lnRef);
  } else if (!ln) {
    paint.stroke = undefined;
  }
  const width = numAttr(ln, 'w');
  if (paint.stroke && paint.stroke !== 'transparent') paint.strokeWidth = Math.max(1, emu(scope.shared, width ?? 12700));
  const dash = attr(child(ln, 'prstDash'), 'val');
  if (dash && dash !== 'solid') paint.dash = /dot/i.test(dash) && !/dash/i.test(dash) ? 'dotted' : 'dashed';
  if (child(ln, 'headEnd') && attr(child(ln, 'headEnd'), 'type') !== 'none') scope.shared.report.dropped('Arrowheads on lines', scope.slideNo);
  if (child(ln, 'tailEnd') && attr(child(ln, 'tailEnd'), 'type') !== 'none') scope.shared.report.dropped('Arrowheads on lines', scope.slideNo);
  if (child(spPr, 'effectLst', 'outerShdw')) paint.shadow = true;
  if (child(spPr, 'effectLst') && kids(child(spPr, 'effectLst')).some((e) => ['glow', 'softEdge', 'reflection', 'innerShdw'].includes(localName(e)))) {
    scope.shared.report.dropped('Glow, soft edge and reflection effects', scope.slideNo);
  }
  if (child(spPr, 'scene3d') || child(spPr, 'sp3d')) scope.shared.report.dropped('3-D effects', scope.slideNo);
  if (fontRef) paint.textColor = colorValue(scope, fontRef);
  return paint;
}

function readBackground(scope: Scope, bg: Element | null, part: Part): Promise<SlideBackground | undefined> {
  return (async () => {
    if (!bg) return undefined;
    const { shared } = scope;
    const bgPr = child(bg, 'bgPr');
    if (!bgPr) {
      // A reference into the theme's background fills: its color is the plain background, the fill style is lost.
      const ref = child(bg, 'bgRef');
      const color = colorValue(scope, ref);
      if (!color) return undefined;
      if ((numAttr(ref, 'idx') ?? 1001) >= 1002) shared.report.approximated('Theme background styles (gradient or texture)', scope.slideNo, 'a plain color is used');
      return { kind: 'color', color };
    }
    const fill = kids(bgPr).find((c) => FILL_TAGS.includes(localName(c)));
    if (!fill) return undefined;
    const name = localName(fill);
    if (name === 'solidFill') {
      const color = colorValue(scope, fill);
      return color ? { kind: 'color', color } : undefined;
    }
    if (name === 'gradFill') {
      const stops: GradientStop[] = [];
      for (const gs of kids(child(fill, 'gsLst'), 'gs')) {
        const color = colorValue(scope, gs);
        if (color) stops.push({ offset: Math.min(Math.max((numAttr(gs, 'pos') ?? 0) / 100000, 0), 1), color });
      }
      if (stops.length < 2) return stops[0] ? { kind: 'color', color: stops[0].color } : undefined;
      const radial = !!child(fill, 'path');
      // DrawingML measures from "left to right", clockwise; the model, like CSS, from "upward".
      const angle = radial ? 180 : ((((numAttr(child(fill, 'lin'), 'ang') ?? 5400000) / 60000 + 90) % 360) + 360) % 360;
      return { kind: 'gradient', angle, stops: stops.slice(0, 12), ...(radial ? { radial: true } : {}) };
    }
    if (name === 'blipFill') {
      const rel = part.rels.get(attr(child(fill, 'blip'), 'embed') ?? '');
      const url = rel && !rel.external ? await addMedia(scope, rel.target) : null;
      return url ? { kind: 'image', url } : undefined;
    }
    shared.report.approximated('Pattern backgrounds', scope.slideNo, 'dropped; the master background shows');
    return undefined;
  })();
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

function kindOfPh(type: string | undefined): PlaceholderKind | 'ignore' {
  switch (type) {
    case 'title':
    case 'ctrTitle':
    case 'vertTitle':
      return 'title';
    case 'subTitle':
      return 'subtitle';
    case 'pic':
      return 'image';
    case 'ftr':
      return 'footer';
    case 'sldNum':
      return 'slideNumber';
    case 'dt':
      return 'date';
    case 'hdr':
      return 'ignore';
    default:
      return 'body';
  }
}

const CHROME: PlaceholderKind[] = ['footer', 'slideNumber', 'date'];
const LOSSY_PH_TYPES = ['tbl', 'chart', 'dgm', 'media', 'clipArt', 'obj'];

function phOf(el: Element): { type: string; idx?: string } | null {
  const ph = child(el, 'nvSpPr', 'nvPr', 'ph') ?? child(el, 'nvPicPr', 'nvPr', 'ph') ?? child(el, 'nvGraphicFramePr', 'nvPr', 'ph');
  if (!ph) return null;
  return { type: attr(ph, 'type') ?? 'obj', idx: attr(ph, 'idx') };
}

/** The layout placeholder a slide's placeholder fills: by index, else by type. */
function findLayoutPh(layout: LayoutInfo | undefined, ph: { type: string; idx?: string }): PhDef | undefined {
  if (!layout) return undefined;
  if (ph.idx !== undefined) {
    const byIdx = layout.phs.find((p) => p.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  const kind = kindOfPh(ph.type);
  return layout.phs.find((p) => p.type === ph.type) ?? layout.phs.find((p) => p.kind === kind && (p.idx === undefined || ph.idx === undefined));
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const EXACT_PRESETS: Record<string, SlideShapeKind> = {
  rect: 'rectangle',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  triangle: 'triangle',
  diamond: 'diamond',
  rightArrow: 'arrowRight',
  leftArrow: 'arrowLeft',
  upArrow: 'arrowUp',
  downArrow: 'arrowDown',
  line: 'line',
  straightConnector1: 'line',
};

const NEAREST_PRESETS: Record<string, SlideShapeKind> = {
  flowChartProcess: 'rectangle',
  flowChartAlternateProcess: 'roundRect',
  flowChartDecision: 'diamond',
  flowChartTerminator: 'roundRect',
  round1Rect: 'roundRect',
  round2SameRect: 'roundRect',
  round2DiagRect: 'roundRect',
  snip1Rect: 'rectangle',
  snip2SameRect: 'rectangle',
  rtTriangle: 'triangle',
  isosTriangle: 'triangle',
  wedgeRectCallout: 'callout',
  wedgeRoundRectCallout: 'callout',
  wedgeEllipseCallout: 'callout',
  borderCallout1: 'callout',
  star4: 'star',
  star5: 'star',
  star6: 'star',
  star7: 'star',
  star8: 'star',
  star10: 'star',
  star12: 'star',
  star16: 'star',
  star24: 'star',
  star32: 'star',
  bentUpArrow: 'arrowUp',
  uturnArrow: 'arrowRight',
  stripedRightArrow: 'arrowRight',
  notchedRightArrow: 'arrowRight',
  homePlate: 'arrowRight',
  chevron: 'arrowRight',
  curvedConnector3: 'line',
  bentConnector3: 'line',
};

function presetOf(scope: Scope, prst: string | undefined): SlideShapeKind {
  if (!prst) return 'rectangle';
  if (EXACT_PRESETS[prst]) return EXACT_PRESETS[prst];
  const near = NEAREST_PRESETS[prst];
  scope.shared.report.approximated('Shapes without an equivalent', scope.slideNo, near ? `drawn as the nearest shape (for example ${prst})` : `drawn as a rectangle (for example ${prst})`);
  return near ?? 'rectangle';
}

interface Emit {
  out: SlideElement[];
  tf: Affine;
}

const newId = () => randomId();

function register(scope: Scope, spid: string | undefined, ids: string[]) {
  if (spid && ids.length) scope.spids.set(spid, [...(scope.spids.get(spid) ?? []), ...ids]);
}

function anchorOf(bodyPr: Element | null): 'top' | 'middle' | 'bottom' | undefined {
  const a = attr(bodyPr, 'anchor');
  return a === 't' ? 'top' : a === 'ctr' ? 'middle' : a === 'b' ? 'bottom' : undefined;
}

/** PowerPoint's margins for a text body that sets none: 0.1" at the sides, 0.05" above and below. */
const DEFAULT_INSETS = { lIns: 91440, tIns: 45720, rIns: 91440, bIns: 45720 } as const;
const INSET_KEYS = { lIns: 'insetLeft', tIns: 'insetTop', rIns: 'insetRight', bIns: 'insetBottom' } as const;

/**
 * What a text body's `a:bodyPr` sets of its margins, wrapping and columns.
 * With `defaults`, margins it leaves out are PowerPoint's, for a box with
 * nothing to inherit them from; otherwise they are left out, to be inherited.
 */
function bodyLayoutOf(shared: Shared, bodyPr: Element | null, defaults: boolean): PlaceholderStyle {
  const out: PlaceholderStyle = {};
  for (const [name, key] of Object.entries(INSET_KEYS) as [keyof typeof INSET_KEYS, (typeof INSET_KEYS)[keyof typeof INSET_KEYS]][]) {
    const value = numAttr(bodyPr, name) ?? (defaults ? DEFAULT_INSETS[name] : undefined);
    if (value !== undefined) out[key] = emu(shared, Math.max(value, 0));
  }
  const wrap = attr(bodyPr, 'wrap');
  if (wrap === 'none') out.wrap = false;
  else if (wrap === 'square') out.wrap = true;
  const columns = numAttr(bodyPr, 'numCol');
  if (columns !== undefined) out.columns = Math.min(Math.max(Math.round(columns), 1), MAX_TEXT_COLUMNS);
  const gap = numAttr(bodyPr, 'spcCol');
  if (gap !== undefined) out.columnGap = emu(shared, Math.max(gap, 0));
  return out;
}

function formatChainOf(scope: Scope, txBody: Element | null, ph: PhDef | undefined): TextOptions {
  const own = child(txBody, 'lstStyle');
  const { master } = scope.shared;
  const masterTx = ph?.kind === 'title' ? master.titleStyle : ph ? master.bodyStyle : master.otherStyle;
  const masterPh = ph ? master.lst.get(ph.kind === 'subtitle' || ph.kind === 'image' ? 'body' : ph.kind) : null;
  return { formatChain: [own], bulletChain: [own, ph?.lst ?? null, masterPh ?? null, masterTx] };
}

async function convertSp(scope: Scope, sp: Element, emit: Emit): Promise<void> {
  const nv = child(sp, 'nvSpPr') ?? child(sp, 'nvCxnSpPr');
  const cNvPr = child(nv, 'cNvPr');
  const spid = attr(cNvPr, 'id');
  const spPr = child(sp, 'spPr');
  const txBody = child(sp, 'txBody');
  const style = child(sp, 'style');
  const ph = phOf(sp);
  const { shared } = scope;
  const placed = readXfrm(scope, child(spPr, 'xfrm'), emit.tf);

  if (ph && (scope.kind === 'slide' || scope.kind === 'diagram')) {
    await convertSlidePlaceholder(scope, sp, ph, placed, emit);
    return;
  }
  if (ph) return; // Layout and master placeholders are read apart, as placeholders.
  if (!placed) return;
  if (attr(cNvPr, 'hidden') === '1') return;

  const bodyPr = child(txBody, 'bodyPr');
  if (attr(bodyPr, 'vert') && attr(bodyPr, 'vert') !== 'horz') shared.report.approximated('Vertical text', scope.slideNo, 'drawn horizontally');
  const paint = readPaint(scope, spPr, style);
  const options = formatChainOf(scope, txBody, undefined);
  const paragraphs = txBody ? readParagraphs(scope.text, txBody, options) : [];
  const hasText = paragraphsHaveText(paragraphs);

  const geometry = child(spPr, 'prstGeom');
  const custom = child(spPr, 'custGeom');
  const prst = attr(geometry, 'prst');
  const isTextBox = attr(child(nv, 'cNvSpPr'), 'txBox') === '1';
  const base = { z: 0, ...(placed.rotation ? { rotation: Math.round(placed.rotation * 100) / 100 } : {}) };
  const ids: string[] = [];
  const push = (element: SlideElement) => {
    element.z = emit.out.length + 1;
    emit.out.push(element);
    ids.push(element.id);
  };

  const textBox = (extra: Partial<SlideElement> = {}): SlideElement =>
    ({
      id: newId(),
      type: 'richText',
      ...base,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      paragraphs,
      fontSize: shared.defaultFontSize,
      autofit: child(bodyPr, 'normAutofit') ? true : false,
      verticalAlign: anchorOf(bodyPr) ?? 'top',
      ...bodyLayoutOf(shared, bodyPr, true),
      ...(paint.textColor ? { color: paint.textColor } : {}),
      ...extra,
    }) as unknown as SlideElement;

  const kind = custom ? null : presetOf(scope, prst);
  const drawn = (paint.fill && paint.fill !== 'transparent') || (paint.stroke && paint.stroke !== 'transparent');

  if (kind === 'line') {
    // A line is a flat shape turned to run corner to corner of its frame.
    const length = Math.hypot(placed.width, placed.height);
    const slope = (Math.atan2(placed.height, placed.width) * 180) / Math.PI * (placed.flipH !== placed.flipV ? -1 : 1);
    const thickness = Math.max(paint.strokeWidth ?? 2, 2);
    const cx = placed.x + placed.width / 2;
    const cy = placed.y + placed.height / 2;
    push({
      id: newId(),
      type: 'shape',
      shape: 'line',
      x: Math.round(cx - length / 2),
      y: Math.round(cy - thickness / 2),
      width: Math.round(length),
      height: Math.round(thickness),
      z: 0,
      rotation: Math.round((((slope + placed.rotation) % 360) + 360) % 360 * 100) / 100,
      stroke: paint.stroke ?? '#000000',
      strokeWidth: paint.strokeWidth ?? 2,
      ...(paint.dash ? { dash: paint.dash } : {}),
    } as unknown as SlideElement);
    register(scope, spid, ids);
    return;
  }

  if (custom) {
    const raster = await rasterizeCustom(scope, custom, placed, paint);
    if (raster) {
      push({ id: newId(), type: 'image', url: raster, ...base, x: placed.x, y: placed.y, width: placed.width, height: placed.height, alt: attr(cNvPr, 'descr') } as unknown as SlideElement);
    } else if (drawn) {
      shared.report.approximated('Freeform shapes', scope.slideNo, 'drawn as a rectangle');
      push({ id: newId(), type: 'shape', shape: 'rectangle', ...base, x: placed.x, y: placed.y, width: placed.width, height: placed.height, ...shapePaint(paint) } as unknown as SlideElement);
    }
    if (hasText) push(textBox({ fill: undefined, stroke: undefined }));
    register(scope, spid, ids);
    return;
  }

  if (hasText && (kind === 'rectangle' || isTextBox)) {
    push(
      textBox({
        ...(paint.fill && paint.fill !== 'transparent' ? { fill: paint.fill } : {}),
        ...(paint.stroke && paint.stroke !== 'transparent' ? { stroke: paint.stroke, strokeWidth: paint.strokeWidth ?? 2 } : {}),
      }),
    );
  } else {
    if (drawn || (!hasText && kind !== 'rectangle')) {
      push({ id: newId(), type: 'shape', shape: kind ?? 'rectangle', ...base, x: placed.x, y: placed.y, width: placed.width, height: placed.height, ...shapePaint(paint) } as unknown as SlideElement);
    }
    if (hasText) push(textBox());
  }
  register(scope, spid, ids);
}

function shapePaint(paint: Paint): Record<string, unknown> {
  return {
    fill: paint.fill ?? 'transparent',
    ...(paint.stroke ? { stroke: paint.stroke } : { stroke: 'transparent' }),
    ...(paint.strokeWidth ? { strokeWidth: paint.strokeWidth } : {}),
    ...(paint.dash ? { dash: paint.dash } : {}),
    ...(paint.shadow ? { shadow: true } : {}),
  };
}

async function convertSlidePlaceholder(scope: Scope, sp: Element, ph: { type: string; idx?: string }, placed: Placed | null, emit: Emit) {
  const { shared } = scope;
  const kind = kindOfPh(ph.type);
  const spid = attr(child(sp, 'nvSpPr', 'cNvPr'), 'id');
  const txBody = child(sp, 'txBody');
  const paragraphsFor = (def: PhDef | undefined) => readParagraphs(scope.text, txBody, formatChainOf(scope, txBody, def));

  if (kind === 'ignore') return;
  if (CHROME.includes(kind as PlaceholderKind)) {
    const paragraphs = txBody ? readParagraphs(scope.text, txBody, { formatChain: [], bulletChain: [] }) : [];
    const text = plainParagraphs(paragraphs).join(' ').trim();
    const chrome = scope.chrome;
    if (!chrome) return;
    if (kind === 'footer') {
      chrome.showFooter = true;
      if (text) chrome.footerText = text;
    } else if (kind === 'slideNumber') chrome.showSlideNumber = true;
    else {
      chrome.showDate = true;
      const isField = descendants(txBody, 'fld').length > 0;
      if (text && !isField) chrome.dateText = text;
    }
    return;
  }

  const def = findLayoutPh(scope.layout, ph);
  const paragraphs = paragraphsFor(def);
  if (!paragraphsHaveText(paragraphs)) return; // An empty placeholder shows only its prompt, which is not slide content.

  const bodyPr = child(txBody, 'bodyPr');
  const patch: Record<string, unknown> = {};
  const anchor = anchorOf(bodyPr);
  if (anchor) patch.verticalAlign = anchor;
  if (def && placed) {
    // Written only where the slide moves the box, so the box keeps following its layout.
    const inherited = layoutBox(shared, scope.layout, def);
    if (!inherited || !sameBox(inherited, placed)) Object.assign(patch, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
  }
  const free = !def;
  const box = placed ?? (free ? fallbackBox(shared, kind) : null);
  if (free && box) Object.assign(patch, { x: box.x, y: box.y, width: box.width, height: box.height });
  if (free) Object.assign(patch, { fontSize: shared.defaultFontSize });
  Object.assign(patch, bodyLayoutOf(shared, bodyPr, free));
  if (placed?.rotation) patch.rotation = placed.rotation;

  const element = {
    id: newId(),
    type: 'richText',
    ...(def ? { placeholder: def.id } : {}),
    paragraphs,
    z: emit.out.length + 1,
    ...patch,
  } as unknown as SlideElement;
  emit.out.push(element);
  register(scope, spid, [element.id]);
}

function fallbackBox(shared: Shared, kind: PlaceholderKind | 'ignore'): Box | null {
  const master = shared.master.placeholders.find((p) => p.kind === (kind === 'subtitle' || kind === 'image' ? 'body' : kind));
  return master ? { x: master.x, y: master.y, width: master.width, height: master.height } : null;
}

/** A layout placeholder's box, falling back to the master's for what the layout does not set. */
function layoutBox(shared: Shared, layout: LayoutInfo | undefined, def: PhDef): Box | null {
  const own = layout?.layout.placeholders.find((p) => p.id === def.id);
  const base = fallbackBox(shared, def.kind);
  if (!own && !base) return null;
  return {
    x: own?.x ?? base?.x ?? 0,
    y: own?.y ?? base?.y ?? 0,
    width: own?.width ?? base?.width ?? 0,
    height: own?.height ?? base?.height ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Custom geometry
// ---------------------------------------------------------------------------

function arcToCubics(cx: number, cy: number, wR: number, hR: number, start: number, sweep: number): PathCommand[] {
  const out: PathCommand[] = [];
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / segments;
  const t = (4 / 3) * Math.tan(step / 4);
  let a = start;
  for (let i = 0; i < segments; i++) {
    const a2 = a + step;
    const [c1, s1, c2, s2] = [Math.cos(a), Math.sin(a), Math.cos(a2), Math.sin(a2)];
    out.push(['C', cx + wR * (c1 - t * s1), cy + hR * (s1 + t * c1), cx + wR * (c2 + t * s2), cy + hR * (s2 - t * c2), cx + wR * c2, cy + hR * s2]);
    a = a2;
  }
  return out;
}

function readCustomPaths(custom: Element): ShapeRaster['paths'] {
  const paths: ShapeRaster['paths'] = [];
  for (const path of kids(child(custom, 'pathLst'), 'path')) {
    const commands: PathCommand[] = [];
    let cx = 0;
    let cy = 0;
    const pt = (el: Element | null): [number, number] => [numAttr(el, 'x') ?? 0, numAttr(el, 'y') ?? 0];
    for (const cmd of kids(path)) {
      const name = localName(cmd);
      const pts = kids(cmd, 'pt');
      if (name === 'moveTo' && pts[0]) {
        [cx, cy] = pt(pts[0]);
        commands.push(['M', cx, cy]);
      } else if (name === 'lnTo' && pts[0]) {
        [cx, cy] = pt(pts[0]);
        commands.push(['L', cx, cy]);
      } else if (name === 'cubicBezTo' && pts.length >= 3) {
        const [a, b, c] = pts.map(pt);
        commands.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]);
        [cx, cy] = c;
      } else if (name === 'quadBezTo' && pts.length >= 2) {
        const [q, e] = pts.map(pt);
        commands.push(['C', cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]);
        [cx, cy] = e;
      } else if (name === 'arcTo') {
        const wR = numAttr(cmd, 'wR') ?? 0;
        const hR = numAttr(cmd, 'hR') ?? 0;
        const st = ((numAttr(cmd, 'stAng') ?? 0) / 60000) * (Math.PI / 180);
        const sw = ((numAttr(cmd, 'swAng') ?? 0) / 60000) * (Math.PI / 180);
        if (wR > 0 && hR > 0) {
          const centerX = cx - wR * Math.cos(st);
          const centerY = cy - hR * Math.sin(st);
          const arcs = arcToCubics(centerX, centerY, wR, hR, st, sw);
          commands.push(...arcs);
          const last = arcs[arcs.length - 1];
          if (last && last[0] === 'C') [cx, cy] = [last[5], last[6]];
        }
      } else if (name === 'close') commands.push(['Z']);
    }
    paths.push({ w: numAttr(path, 'w') ?? 0, h: numAttr(path, 'h') ?? 0, commands, fill: attr(path, 'fill') !== 'none', stroke: attr(path, 'stroke') !== '0' });
  }
  return paths;
}

async function rasterizeCustom(scope: Scope, custom: Element, placed: Placed, paint: Paint): Promise<string | null> {
  const { shared } = scope;
  if (!shared.rasterize || placed.width < 1 || placed.height < 1) return null;
  const paths = readCustomPaths(custom).filter((p) => p.commands.length > 0);
  if (paths.length === 0) return null;
  const scale = Math.min(1, 1600 / Math.max(placed.width, placed.height));
  const concrete = (c: string | undefined) => (c && c !== 'transparent' ? concreteColor(c, shared.theme) : undefined);
  const data = await shared.rasterize({
    width: Math.max(1, Math.round(placed.width * scale)),
    height: Math.max(1, Math.round(placed.height * scale)),
    paths: paths.map((p) => ({ ...p, w: p.w || placed.width, h: p.h || placed.height })),
    fill: concrete(paint.fill),
    stroke: concrete(paint.stroke),
    strokeWidth: (paint.strokeWidth ?? 2) * scale,
  });
  if (!data) return null;
  const key = `m${shared.media.length + 1}`;
  shared.media.push({ key, name: `shape-${key}.png`, mimeType: 'image/png', data });
  shared.report.approximated('Freeform shapes', scope.slideNo, 'turned into pictures, so their outline is no longer editable');
  return mediaUrl(key);
}

// ---------------------------------------------------------------------------
// Pictures, media, tables, graphic frames
// ---------------------------------------------------------------------------

async function convertPic(scope: Scope, pic: Element, emit: Emit): Promise<void> {
  const { shared } = scope;
  const spid = attr(child(pic, 'nvPicPr', 'cNvPr'), 'id');
  const ph = phOf(pic);
  const placed = readXfrm(scope, child(pic, 'spPr', 'xfrm'), emit.tf);
  const nvPr = child(pic, 'nvPicPr', 'nvPr');
  const alt = attr(child(pic, 'nvPicPr', 'cNvPr'), 'descr') || undefined;

  // Video and sound: the file itself when the package carries it, else the link.
  const video = child(nvPr, 'videoFile');
  const audio = child(nvPr, 'audioFile');
  if (video || audio) {
    if (!placed) return;
    const embedded = descendants(nvPr, 'media').map((m) => scope.part.rels.get(attr(m, 'embed') ?? '')).find(Boolean);
    const linked = scope.part.rels.get(attr(video ?? audio, 'link') ?? '');
    const rel = embedded ?? linked;
    let url: string | null = null;
    if (rel?.external) url = /^https?:/i.test(rel.target) ? rel.target : null;
    else if (rel) url = await addMedia(scope, rel.target);
    if (!url) {
      shared.report.dropped(video ? 'Videos that are not in the file' : 'Sounds that are not in the file', scope.slideNo);
      return;
    }
    const type = video ? 'video' : 'audio';
    const element = { id: newId(), type, url, title: alt, x: placed.x, y: placed.y, width: placed.width, height: placed.height, z: emit.out.length + 1 } as unknown as SlideElement;
    emit.out.push(element);
    register(scope, spid, [element.id]);
    if (rel?.external) shared.report.approximated('Linked media', scope.slideNo, 'kept as a link to the original address');
    return;
  }

  const blip = child(pic, 'blipFill', 'blip');
  const rel = scope.part.rels.get(attr(blip, 'embed') ?? '');
  if (!rel) return;
  if (rel.external) {
    shared.report.dropped('Pictures linked from other files', scope.slideNo);
    return;
  }
  const url = await addMedia(scope, rel.target);
  if (!url) return;

  const def = ph ? findLayoutPh(scope.layout, ph) : undefined;
  if (!placed && !def) return;
  const element: Record<string, unknown> = { id: newId(), type: 'image', url, fit: 'cover', z: emit.out.length + 1 };
  if (alt) element.alt = alt;
  const crop = stretchCrop(child(pic, 'blipFill'));
  if (crop) element.crop = crop;
  const alphaFix = numAttr(child(blip, 'alphaModFix'), 'amt');
  if (alphaFix !== undefined && alphaFix < 100000) element.opacity = alphaFix / 100000;
  if (placed) {
    const inherited = def ? layoutBox(shared, scope.layout, def) : null;
    if (!def || !inherited || !sameBox(inherited, placed)) Object.assign(element, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    if (placed.rotation) element.rotation = placed.rotation;
    if (placed.flipH || placed.flipV) shared.report.approximated('Flipped pictures', scope.slideNo, 'drawn unflipped');
  }
  if (def) element.placeholder = def.id;
  if (child(blip, 'duotone') || child(blip, 'lum') || child(blip, 'biLevel')) shared.report.approximated('Picture recoloring and brightness', scope.slideNo, 'original colors shown');
  if (child(pic, 'spPr', 'prstGeom') && !['rect', undefined].includes(attr(child(pic, 'spPr', 'prstGeom'), 'prst'))) {
    shared.report.approximated('Pictures cropped to a shape', scope.slideNo, 'shown as rectangles');
  }
  emit.out.push(element as unknown as SlideElement);
  register(scope, spid, [element.id as string]);
}

/**
 * The part of a picture its frame shows, as a crop. PowerPoint stretches the
 * picture's source rectangle over the frame's fill rectangle whatever their
 * shapes, so the picture always gets a crop, which draws stretched; negative
 * insets on either rectangle leave a margin around the picture. A tiled
 * picture has no crop and is drawn to cover its frame.
 */
function stretchCrop(blipFill: Element | null): { x: number; y: number; width: number; height: number } | undefined {
  const stretch = child(blipFill, 'stretch');
  if (!stretch && child(blipFill, 'tile')) return undefined;
  const src = child(blipFill, 'srcRect');
  const fill = child(stretch, 'fillRect');
  const inset = (el: Element | null, name: string) => (numAttr(el, name) ?? 0) / 100000;
  const axis = (from: number, to: number, fillFrom: number, fillTo: number) => {
    const shown = 1 - from - to;
    const filled = 1 - fillFrom - fillTo;
    if (shown <= 0 || filled <= 0) return null;
    const size = shown / filled;
    return { start: from - fillFrom * size, size };
  };
  const h = axis(inset(src, 'l'), inset(src, 'r'), inset(fill, 'l'), inset(fill, 'r'));
  const v = axis(inset(src, 't'), inset(src, 'b'), inset(fill, 't'), inset(fill, 'b'));
  if (!h || !v) return undefined;
  return { x: h.start, y: v.start, width: h.size, height: v.size };
}

function readCellText(scope: Scope, tc: Element): Partial<TableCell> {
  const txBody = child(tc, 'txBody');
  const paragraphs = txBody ? readParagraphs(scope.text, txBody, { formatChain: [child(txBody, 'lstStyle')], bulletChain: [] }) : [];
  const text = plainParagraphs(paragraphs).join('\n');
  const firstRun = paragraphs.flatMap((p: RichParagraph) => p.runs).find((run) => (run.text ?? '') !== '');
  const marks = firstRun?.marks;
  const cell: Partial<TableCell> = { text };
  if (marks?.bold) cell.bold = true;
  if (marks?.italic) cell.italic = true;
  if (marks?.underline) cell.underline = true;
  if (marks?.color) cell.color = marks.color;
  if (marks?.fontSize) cell.fontSize = marks.fontSize;
  const align = paragraphs[0]?.align;
  if (align === 'center' || align === 'right') cell.align = align;
  if (paragraphs.length > 0 && paragraphs.some((p) => p.runs.some((r) => r.marks && (r.marks !== marks) && JSON.stringify(r.marks) !== JSON.stringify(marks)))) {
    scope.shared.report.approximated('Mixed formatting inside table cells', scope.slideNo, 'the first run sets the cell format');
  }
  return cell;
}

async function convertTable(scope: Scope, frame: Element, tbl: Element, placed: Placed, emit: Emit) {
  const { shared } = scope;
  const columns = kids(child(tbl, 'tblGrid'), 'gridCol').map((c) => (numAttr(c, 'w') ?? 1) || 1);
  const rows = kids(tbl, 'tr');
  if (columns.length === 0 || rows.length === 0) return;
  const cells: Record<string, TableCell> = {};
  rows.forEach((tr, r) => {
    let column = 0;
    for (const tc of kids(tr, 'tc')) {
      if (column >= columns.length) break;
      const spanX = numAttr(tc, 'gridSpan') ?? 1;
      const spanY = numAttr(tc, 'rowSpan') ?? 1;
      const merged = boolAttr(tc, 'hMerge') || boolAttr(tc, 'vMerge');
      if (!merged) {
        const cell = readCellText(scope, tc) as TableCell;
        const tcPr = child(tc, 'tcPr');
        const fill = kids(tcPr).find((c) => FILL_TAGS.includes(localName(c)));
        if (fill && localName(fill) === 'solidFill') cell.fill = colorValue(scope, fill);
        const v = attr(tcPr, 'anchor');
        if (v === 'ctr') cell.verticalAlign = 'middle';
        else if (v === 'b') cell.verticalAlign = 'bottom';
        const edge = ['lnB', 'lnT', 'lnL', 'lnR'].map((n) => child(tcPr, n)).find((ln) => ln && child(ln, 'solidFill'));
        if (edge) {
          cell.borderColor = colorValue(scope, child(edge, 'solidFill'));
          cell.borderWidth = Math.max(1, emu(shared, numAttr(edge, 'w') ?? 12700));
        }
        if (spanX > 1) cell.colSpan = spanX;
        if (spanY > 1) cell.rowSpan = spanY;
        const hasContent = cell.text || cell.fill || cell.borderColor || spanX > 1 || spanY > 1;
        if (hasContent) cells[`${r}:${column}`] = cell;
      }
      column += 1;
    }
  });
  const tblPr = child(tbl, 'tblPr');
  if (child(tblPr, 'tableStyleId')) shared.report.approximated('Table styles', scope.slideNo, 'only fills and borders set on cells are kept');
  const element = {
    id: newId(),
    type: 'table',
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    z: emit.out.length + 1,
    rows: rows.length,
    columns: columns.length,
    columnWidths: columns,
    rowHeights: rows.map((tr) => (numAttr(tr, 'h') ?? 1) || 1),
    cells,
    fontSize: shared.defaultFontSize,
    headerRow: boolAttr(tblPr, 'firstRow') ?? false,
  } as unknown as SlideElement;
  emit.out.push(element);
  register(scope, attr(child(frame, 'nvGraphicFramePr', 'cNvPr'), 'id'), [element.id]);
}

async function convertSmartArt(scope: Scope, frame: Element, placed: Placed, emit: Emit) {
  const { shared } = scope;
  const relIds = descendants(frame, 'relIds')[0];
  const dataRel = scope.part.rels.get(attr(relIds, 'dm') ?? '');
  const data = dataRel ? await loadPart(shared, dataRel.target) : null;
  const drawingRelId = attr(descendants(data?.root, 'dataModelExt')[0], 'relId');
  const drawingRel = drawingRelId ? scope.part.rels.get(drawingRelId) : undefined;
  const drawing = drawingRel ? await loadPart(shared, drawingRel.target) : null;
  if (!drawing) {
    placeholderFor(scope, 'SmartArt graphics', placed, emit, 'SmartArt');
    return;
  }
  // The drawing part is what PowerPoint last rendered the graphic as: ordinary shapes, in the frame's own coordinates.
  const inner: Scope = { ...scope, kind: 'diagram', part: drawing };
  const tf: Affine = { sx: 1, sy: 1, dx: placed.x / shared.k, dy: placed.y / shared.k };
  await walkTree(inner, child(drawing.root, 'spTree') ?? drawing.root, { out: emit.out, tf });
  shared.report.approximated('SmartArt graphics', scope.slideNo, 'kept as plain shapes and text; they no longer re-layout');
}

function placeholderFor(scope: Scope, feature: string, placed: Placed, emit: Emit, label: string) {
  scope.shared.report.dropped(feature, scope.slideNo, 'the file carries no picture of it; a marked box stands in');
  emit.out.push({
    id: newId(),
    type: 'shape',
    shape: 'rectangle',
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    z: emit.out.length + 1,
    fill: 'transparent',
    stroke: '#9ca3af',
    strokeWidth: 2,
    dash: 'dashed',
    text: `${label} (not imported)`,
  } as unknown as SlideElement);
}

async function convertFrame(scope: Scope, frame: Element, emit: Emit): Promise<void> {
  const placed = readXfrm(scope, child(frame, 'xfrm'), emit.tf);
  if (!placed) return;
  const data = child(frame, 'graphic', 'graphicData');
  const uri = attr(data, 'uri') ?? '';
  const tbl = child(data, 'tbl');
  if (tbl) return convertTable(scope, frame, tbl, placed, emit);
  if (uri.endsWith('/diagram')) return convertSmartArt(scope, frame, placed, emit);
  if (uri.endsWith('/chart') || uri.includes('chartex')) {
    // Charts carry no fallback picture on the slide itself; one in an AlternateContent wrapper was already used.
    return placeholderFor(scope, 'Charts', placed, emit, 'Chart');
  }
  if (child(data, 'oleObj')) {
    const pic = child(data, 'oleObj', 'pic');
    if (pic) return convertPic(scope, pic, emit);
    return placeholderFor(scope, 'Embedded objects', placed, emit, 'Embedded object');
  }
  return placeholderFor(scope, 'Unsupported content', placed, emit, 'Content');
}

// ---------------------------------------------------------------------------
// Shape tree
// ---------------------------------------------------------------------------

const SUPPORTED_NAMESPACE_PREFIXES = new Set(['p14', 'a14', 'p15', 'p16', 'a16', 'pic', 'p159', 'ahyp', 'thm15']);

/** An `mc:AlternateContent`'s Choice when this reader understands what it requires, else its Fallback. */
function alternateOf(el: Element): Element | null {
  for (const choice of kids(el, 'Choice')) {
    const requires = (attr(choice, 'Requires') ?? '').split(/\s+/).filter(Boolean);
    if (requires.every((r) => SUPPORTED_NAMESPACE_PREFIXES.has(r))) return choice;
  }
  return child(el, 'Fallback');
}

async function walkTree(scope: Scope, tree: Element, emit: Emit): Promise<void> {
  for (const node of kids(tree)) {
    const name = localName(node);
    switch (name) {
      case 'sp':
      case 'cxnSp':
        await convertSp(scope, node, emit);
        break;
      case 'pic':
        await convertPic(scope, node, emit);
        break;
      case 'graphicFrame':
        await convertFrame(scope, node, emit);
        break;
      case 'grpSp': {
        const tf = groupTransform(child(node, 'grpSpPr', 'xfrm'), emit.tf);
        const before = emit.out.length;
        await walkTree(scope, node, { out: emit.out, tf });
        const rotation = numAttr(child(node, 'grpSpPr', 'xfrm'), 'rot');
        if (rotation) scope.shared.report.approximated('Rotated groups', scope.slideNo, 'members keep their own rotation');
        const spid = attr(child(node, 'nvGrpSpPr', 'cNvPr'), 'id');
        register(scope, spid, emit.out.slice(before).map((e) => e.id));
        break;
      }
      case 'AlternateContent': {
        const chosen = alternateOf(node);
        if (chosen) await walkTree(scope, chosen, emit);
        break;
      }
      case 'contentPart':
        scope.shared.report.dropped('Ink and embedded content', scope.slideNo);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Master and layouts
// ---------------------------------------------------------------------------

/** A master or layout placeholder's style. `defaults` fills in PowerPoint's margins where it has none to inherit. */
function styleOfPlaceholder(scope: Scope, lvl1: (Element | null)[], bodyPr: Element | null, spPr: Element | null, defaults: boolean): PlaceholderStyle {
  const style: PlaceholderStyle = {};
  for (const lvl of [...lvl1].reverse()) Object.assign(style, levelStyle(scope.text, lvl));
  Object.assign(style, bodyLayoutOf(scope.shared, bodyPr, defaults));
  const anchor = anchorOf(bodyPr);
  if (anchor) style.verticalAlign = anchor;
  if (child(bodyPr, 'normAutofit')) style.autofit = true;
  else if (child(bodyPr, 'noAutofit') || child(bodyPr, 'spAutoFit')) style.autofit = false;
  const fill = kids(spPr).find((c) => FILL_TAGS.includes(localName(c)));
  if (fill && localName(fill) === 'solidFill') style.fill = colorValue(scope, fill);
  const ln = child(spPr, 'ln');
  const line = child(ln, 'solidFill');
  if (line) {
    style.stroke = colorValue(scope, line);
    style.strokeWidth = Math.max(1, emu(scope.shared, numAttr(ln, 'w') ?? 12700));
  }
  return style;
}

const diffStyle = (style: PlaceholderStyle, base: PlaceholderStyle | undefined): PlaceholderStyle | undefined => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) if (value !== undefined && (base as Record<string, unknown> | undefined)?.[key] !== value) out[key] = value;
  return Object.keys(out).length ? (out as PlaceholderStyle) : undefined;
};

const MASTER_PH_ID: Partial<Record<PlaceholderKind, string>> = { title: 'title', body: 'body', footer: 'footer', slideNumber: 'slideNumber', date: 'date' };
const MASTER_PH_TYPES: [string, PlaceholderKind][] = [['title', 'title'], ['body', 'body'], ['dt', 'date'], ['ftr', 'footer'], ['sldNum', 'slideNumber']];

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

function textScope(shared: Shared, slideNo: number, rels: Map<string, Rel>): TextScope {
  return {
    ptUnits: (h) => ptUnits(shared, h),
    emuUnits: (v) => emu(shared, v),
    theme: shared.theme,
    report: shared.report,
    slideNo,
    rels,
  };
}

function makeScope(shared: Shared, part: Part, kind: Scope['kind'], slideNo: number, layout?: LayoutInfo): Scope {
  return { shared, part, kind, slideNo, layout, spids: new Map(), text: textScope(shared, slideNo, part.rels) };
}

export async function parsePptx(zip: ZipFiles, options: PptxOptions): Promise<ImportedDeck> {
  const { parseXml, fileName } = options;
  const report = new ReportBuilder();
  const loader = { zip, parseXml };

  const rootRels = await zip.text('_rels/.rels');
  let presentationPath = 'ppt/presentation.xml';
  if (rootRels) {
    const doc = parseRels(parseXml(rootRels), 'package.xml');
    const main = [...doc.values()].find((rel) => rel.type === 'officeDocument');
    if (main) presentationPath = main.target;
  }
  const presentation = await loadPart(loader, presentationPath);
  if (!presentation || localName(presentation.root) !== 'presentation') {
    throw new PackageError('That file is not a PowerPoint presentation (.pptx).');
  }

  const sldSz = child(presentation.root, 'sldSz');
  const { size, k } = chooseSlideSize(numAttr(sldSz, 'cx') ?? 9144000, numAttr(sldSz, 'cy') ?? 6858000);

  // The first master in the deck's list styles the deck; layouts of any master are kept, since slides may sit on them.
  const masterRels = kids(child(presentation.root, 'sldMasterIdLst'), 'sldMasterId')
    .map((entry) => presentation.rels.get(relId(entry) ?? ''))
    .filter((rel): rel is Rel => rel?.type === 'slideMaster');
  if (masterRels.length === 0) masterRels.push(...relsOfType(presentation, 'slideMaster'));
  const masterPart = masterRels[0] ? await loadPart(loader, masterRels[0].target) : null;
  if (masterRels.length > 1) report.approximated('Several slide masters', null, 'the first master is used for the deck; the other masters\' layouts are kept');
  const clrMap = readColorMap(masterPart?.root ?? null);
  const themeRel = masterPart ? relsOfType(masterPart, 'theme')[0] : undefined;
  const themePart = themeRel ? await loadPart(loader, themeRel.target) : null;
  const theme = readTheme(themePart?.root ?? null, clrMap);

  const defaultSz = numAttr(child(presentation.root, 'defaultTextStyle', 'lvl1pPr', 'defRPr'), 'sz') ?? 1800;
  const shared: Shared = {
    zip,
    parseXml,
    report,
    size,
    k,
    theme,
    defaultFontSize: 0,
    rasterize: options.rasterize,
    media: [],
    mediaByPath: new Map(),
    master: undefined as unknown as MasterInfo,
  };
  shared.defaultFontSize = ptUnits(shared, defaultSz);

  // --- master ---
  const master = await buildMaster(shared, masterPart, clrMap);
  shared.master = master.info;

  // --- layouts ---
  // All of the main master's layouts, in its order, so the layout picker matches PowerPoint's; other masters' only where slides use them.
  const layoutPaths: string[] = [];
  const layoutIdList = child(masterPart?.root, 'sldLayoutIdLst');
  for (const entry of kids(layoutIdList, 'sldLayoutId')) {
    const rel = masterPart?.rels.get(relId(entry) ?? '');
    if (rel && !layoutPaths.includes(rel.target)) layoutPaths.push(rel.target);
  }
  const slideRels = relsOfType(presentation, 'slide');
  const slideOrder: Rel[] = [];
  for (const entry of kids(child(presentation.root, 'sldIdLst'), 'sldId')) {
    const rel = presentation.rels.get(relId(entry) ?? '');
    if (rel) slideOrder.push(rel);
  }
  if (slideOrder.length === 0) slideOrder.push(...slideRels);

  const slideParts: Part[] = [];
  for (let i = 0; i < slideOrder.length; i++) {
    options.onProgress?.({ stage: 'reading', done: i, total: slideOrder.length, message: `Reading slide ${i + 1} of ${slideOrder.length}` });
    const part = await loadPart(loader, slideOrder[i].target);
    if (part) {
      slideParts.push(part);
      const layoutRel = relsOfType(part, 'slideLayout')[0];
      if (layoutRel && !layoutPaths.includes(layoutRel.target)) layoutPaths.push(layoutRel.target);
    }
  }

  const layouts: LayoutInfo[] = [];
  for (const path of layoutPaths) {
    const part = await loadPart(loader, path);
    if (part) layouts.push(await buildLayout(shared, part));
  }
  const layoutByPath = new Map(layouts.map((l, i) => [l.part.path, i]));

  // --- slides ---
  const slides: ImportedSlide[] = [];
  const chrome: NonNullable<Scope['chrome']> = {};
  for (let i = 0; i < slideParts.length; i++) {
    options.onProgress?.({ stage: 'parsing', done: i, total: slideParts.length, message: `Converting slide ${i + 1} of ${slideParts.length}` });
    const part = slideParts[i];
    const layoutRel = relsOfType(part, 'slideLayout')[0];
    const layoutIndex = layoutRel ? layoutByPath.get(layoutRel.target) : undefined;
    slides.push(await buildSlide(shared, part, i + 1, layoutIndex === undefined ? undefined : layouts[layoutIndex], layoutIndex ?? null, chrome));
    // Let the worker's event loop breathe on long decks.
    if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const coreTitle = (await zip.text('docProps/core.xml'))?.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1]?.trim();

  return {
    fileName,
    title: coreTitle || fileName.replace(/\.[^.]+$/, '') || 'Imported presentation',
    format: 'pptx',
    size,
    settings: {
      showFooter: chrome.showFooter ?? false,
      showSlideNumber: chrome.showSlideNumber ?? false,
      showDate: chrome.showDate ?? false,
      footerText: chrome.footerText ?? '',
      dateText: chrome.dateText ?? '',
    },
    theme: { name: theme.name, colors: theme.colors, fonts: theme.fonts, colorMap: clrMap },
    master: master.imported,
    layouts: layouts.map((l) => l.layout),
    slides,
    media: shared.media,
    report: report.build(),
  };
}

// ---------------------------------------------------------------------------
// Building the master, layouts and slides
// ---------------------------------------------------------------------------

async function buildMaster(shared: Shared, part: Part | null, clrMap: ColorMap): Promise<{ info: MasterInfo; imported: NonNullable<ImportedDeck['master']> }> {
  const placeholders: MasterPlaceholder[] = [];
  const lst = new Map<string, Element | null>();
  const elements: SlideElement[] = [];
  const info: MasterInfo = {
    part: part ?? { path: '', root: undefined as unknown as Element, rels: new Map() },
    clrMap,
    placeholders,
    lst,
    titleStyle: child(part?.root, 'txStyles', 'titleStyle'),
    bodyStyle: child(part?.root, 'txStyles', 'bodyStyle'),
    otherStyle: child(part?.root, 'txStyles', 'otherStyle'),
  };
  if (!part) return { info, imported: {} };
  shared.master = info;
  const scope = makeScope(shared, part, 'master', 0);
  const tree = child(part.root, 'cSld', 'spTree');

  const background = await readBackground(scope, child(part.root, 'cSld', 'bg'), part);

  for (const sp of kids(tree, 'sp')) {
    const ph = phOf(sp);
    if (!ph) continue;
    const found = MASTER_PH_TYPES.find(([type]) => type === ph.type || (type === 'title' && ph.type === 'ctrTitle') || (type === 'body' && (ph.type === 'obj' || ph.type === 'body')));
    if (!found) continue;
    const [, kind] = found;
    if (placeholders.some((p) => p.kind === kind)) continue;
    const spPr = child(sp, 'spPr');
    const placed = readXfrm(scope, child(spPr, 'xfrm'), IDENTITY);
    const txBody = child(sp, 'txBody');
    const own = child(txBody, 'lstStyle');
    lst.set(kind, own);
    const tx = kind === 'title' ? info.titleStyle : kind === 'body' ? info.bodyStyle : info.otherStyle;
    const style = styleOfPlaceholder(scope, [own ? child(own, 'lvl1pPr') : null, child(tx, 'lvl1pPr')], child(txBody, 'bodyPr'), spPr, true);
    if (placed) {
      placeholders.push({
        id: MASTER_PH_ID[kind] ?? kind,
        kind,
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: placed.height,
        ...(Object.keys(style).length ? { style } : {}),
      });
    }
  }
  info.placeholders = placeholders;
  shared.master = info;

  await walkTree(scope, tree ?? part.root, { out: elements, tf: IDENTITY });
  return {
    info,
    imported: {
      name: attr(child(part.root, 'cSld'), 'name') || 'Master',
      ...(background ? { background } : {}),
      placeholders,
      elements,
    },
  };
}

async function buildLayout(shared: Shared, part: Part): Promise<LayoutInfo> {
  const scope = makeScope(shared, part, 'layout', 0);
  const tree = child(part.root, 'cSld', 'spTree');
  const phs: PhDef[] = [];
  const placeholders: LayoutPlaceholder[] = [];
  const used = new Map<string, number>();
  const info: LayoutInfo = { part, name: attr(child(part.root, 'cSld'), 'name') || 'Layout', layoutType: attr(part.root, 'type'), phs, layout: undefined as unknown as ImportedLayout };

  for (const el of kids(tree)) {
    const ph = phOf(el);
    const name = localName(el);
    if (!ph || !['sp', 'pic', 'graphicFrame'].includes(name)) continue;
    const kind = kindOfPh(ph.type);
    if (kind === 'ignore') continue;
    if (LOSSY_PH_TYPES.includes(ph.type) && ph.type !== 'obj') shared.report.approximated('Layout placeholders for tables, charts, media and SmartArt', null, 'become general content boxes');
    const count = (used.get(kind) ?? 0) + 1;
    used.set(kind, count);
    const id = CHROME.includes(kind) || count === 1 ? kind : `${kind}${count}`;
    const spPr = child(el, name === 'graphicFrame' ? 'xfrm' : 'spPr');
    const xfrmEl = name === 'graphicFrame' ? spPr : child(spPr, 'xfrm');
    const placed = readXfrm(scope, xfrmEl, IDENTITY);
    const txBody = child(el, 'txBody');
    const own = child(txBody, 'lstStyle');
    phs.push({ type: ph.type, idx: ph.idx, kind, id, lst: own });

    const placeholder: LayoutPlaceholder = { id, kind };
    const base = shared.master.placeholders.find((m) => m.kind === (kind === 'subtitle' || kind === 'image' ? 'body' : kind));
    if (placed && (!base || !sameBox(base, placed))) Object.assign(placeholder, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    const style = diffStyle(styleOfPlaceholder(scope, [own ? child(own, 'lvl1pPr') : null], child(txBody, 'bodyPr'), name === 'sp' ? spPr : null, !base), base?.style);
    if (style) placeholder.style = style;
    const prompt = CHROME.includes(kind) ? '' : plainParagraphs(readParagraphs(scope.text, txBody, { formatChain: [], bulletChain: [] })).join(' ').trim();
    if (prompt && !/^click to edit master/i.test(prompt) && prompt.length < 120) placeholder.prompt = prompt;
    placeholders.push(placeholder);
  }

  const elements: SlideElement[] = [];
  await walkTree(scope, tree ?? part.root, { out: elements, tf: IDENTITY });
  const background = await readBackground(scope, child(part.root, 'cSld', 'bg'), part);
  info.layout = {
    sourceId: part.path,
    name: info.name,
    ...(info.layoutType ? { type: info.layoutType } : {}),
    ...(background ? { background } : {}),
    placeholders,
    ...(elements.length ? { elements } : {}),
    ...(attr(part.root, 'showMasterSp') === '0' ? { hideMasterElements: true } : {}),
  };
  return info;
}

const TRANSITIONS: Record<string, SlideTransition['kind']> = {
  fade: 'fade',
  push: 'push',
  wipe: 'wipe',
  zoom: 'zoom',
  cut: 'none',
};
const NEAREST_TRANSITIONS: Record<string, SlideTransition['kind']> = {
  dissolve: 'fade',
  random: 'fade',
  randomBar: 'wipe',
  cover: 'push',
  pull: 'push',
  uncover: 'push',
  split: 'wipe',
  blinds: 'wipe',
  checker: 'fade',
  circle: 'zoom',
  diamond: 'zoom',
  plus: 'zoom',
  wedge: 'wipe',
  wheel: 'wipe',
  strips: 'wipe',
  zoomIn: 'zoom',
};

function readTransition(scope: Scope, root: Element): SlideTransition | undefined {
  // PowerPoint 2010+ effects sit in an AlternateContent whose Fallback is a plain transition.
  let transition: Element | null = child(root, 'transition');
  let duration: number | undefined;
  const wrapper = kids(root, 'AlternateContent').find((a) => child(a, 'Choice', 'transition') || child(a, 'Fallback', 'transition'));
  if (!transition && wrapper) {
    const choice = child(wrapper, 'Choice', 'transition');
    duration = numAttr(choice, 'dur');
    transition = child(wrapper, 'Fallback', 'transition') ?? choice;
  } else if (transition) duration = numAttr(transition, 'dur');
  if (!transition) return undefined;
  const effect = kids(transition).find((c) => localName(c) !== 'sndAc');
  const name = effect ? localName(effect) : 'cut';
  let kind = TRANSITIONS[name];
  if (kind === undefined) {
    kind = NEAREST_TRANSITIONS[name] ?? 'fade';
    scope.shared.report.approximated('Slide transitions without an equivalent', scope.slideNo, `shown as ${kind} (for example ${name})`);
  }
  if (attr(transition, 'advTm')) scope.shared.report.dropped('Automatic slide advance timings', scope.slideNo);
  if (child(transition, 'sndAc')) scope.shared.report.dropped('Transition sounds', scope.slideNo);
  if (kind === 'none') return undefined;
  const spd = attr(transition, 'spd');
  const ms = duration ?? (spd === 'slow' ? 1000 : spd === 'fast' ? 400 : 700);
  return { kind, durationMs: Math.min(Math.max(Math.round(ms), 0), 10000) };
}

async function readNotes(shared: Shared, part: Part, slideNo: number): Promise<string[]> {
  const rel = relsOfType(part, 'notesSlide')[0];
  const notes = rel ? await loadPart(shared, rel.target) : null;
  if (!notes) return [];
  const scope = makeScope(shared, notes, 'slide', slideNo);
  const lines: string[] = [];
  for (const sp of descendants(child(notes.root, 'cSld', 'spTree'), 'sp')) {
    const ph = phOf(sp);
    if (!ph || ph.type !== 'body') continue;
    const paragraphs = readParagraphs(scope.text, child(sp, 'txBody'), { formatChain: [], bulletChain: [] });
    lines.push(...plainParagraphs(paragraphs));
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

async function buildSlide(shared: Shared, part: Part, slideNo: number, layout: LayoutInfo | undefined, layoutIndex: number | null, chrome: NonNullable<Scope['chrome']>): Promise<ImportedSlide> {
  const scope = makeScope(shared, part, 'slide', slideNo, layout);
  scope.chrome = chrome;
  const cSld = child(part.root, 'cSld');
  const elements: SlideElement[] = [];
  await walkTree(scope, child(cSld, 'spTree') ?? part.root, { out: elements, tf: IDENTITY });
  const background = await readBackground(scope, child(cSld, 'bg'), part);
  const transition = readTransition(scope, part.root);

  const timing = child(part.root, 'timing');
  if (timing) {
    const animations = parseTiming(timing, scope.spids, shared.report, slideNo);
    for (const element of elements) {
      const animation = animations.get(element.id);
      if (animation) (element as { animation?: ElementAnimation }).animation = animation;
    }
  }

  return {
    layout: layoutIndex,
    ...(background ? { background } : {}),
    hidden: attr(part.root, 'show') === '0',
    ...(transition ? { transition } : {}),
    elements,
    notes: await readNotes(shared, part, slideNo),
  };
}
