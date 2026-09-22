/**
 * Canvas mode data model.
 *
 * Elements live in the document's Y.Doc under the CANVAS_ELEMENTS root map, as
 * one nested Y.Map per element. Nesting means two people editing different
 * elements — or one dragging while another types — merge cleanly instead of
 * clobbering a single blob.
 */

import { renderCanvasMentions } from './mentions.js';
import { sheetRefMarkdown } from './sheetRefs.js';

export const CANVAS_ELEMENTS = 'canvas-elements';

export type DocumentMode = 'page' | 'canvas';

export type CanvasElementType =
  | 'note'
  | 'text'
  | 'link'
  | 'embed'
  | 'image'
  | 'audio'
  | 'video'
  | 'shape'
  | 'node'
  | 'frame'
  | 'connector'
  | 'sheetCell'
  | 'sheetChart'
  | 'workItem';

export type ShapeKind = 'rectangle' | 'ellipse' | 'diamond' | 'triangle';

export interface CanvasElementBase {
  id: string;
  type: CanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Paint order. Frames sit behind everything else regardless. */
  z: number;
  color?: string;
  createdBy?: string;
  /**
   * Elements sharing a group id are selected and moved together. A field on
   * each member rather than a group element, so a group needs no upkeep: a
   * deleted member simply stops being in it.
   */
  groupId?: string;
}

export interface NoteElement extends CanvasElementBase {
  type: 'note';
  text: string;
}

export interface TextElement extends CanvasElementBase {
  type: 'text';
  text: string;
  fontSize?: number;
}

/** A card pointing at another document in the workspace. */
export interface LinkElement extends CanvasElementBase {
  type: 'link';
  documentId: string;
  /** Cached so the card renders before the document loads. */
  title?: string;
}

export interface EmbedElement extends CanvasElementBase {
  type: 'embed';
  url: string;
  title?: string;
}

export interface ImageElement extends CanvasElementBase {
  type: 'image';
  url: string;
  alt?: string;
}

export interface AudioElement extends CanvasElementBase {
  type: 'audio';
  url: string;
  title?: string;
}

export interface VideoElement extends CanvasElementBase {
  type: 'video';
  url: string;
  title?: string;
}

/** A drawn shape. Its edge is styled like a connector's line. */
export interface ShapeElement extends CanvasElementBase {
  type: 'shape';
  shape: ShapeKind;
  text?: string;
  /** 'transparent' leaves the shape unfilled. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: ConnectorDash;
}

/**
 * A mind-map node. The link to its parent is the relationship itself, not a
 * separate connector element: edges are derived from `parentId` so they cannot
 * be orphaned, dangle, or need tidying by hand.
 */
export interface MindNodeElement extends CanvasElementBase {
  type: 'node';
  text: string;
  /** Undefined for a root node. */
  parentId?: string;
}

/** A named region that doubles as a presentation slide. */
export interface FrameElement extends CanvasElementBase {
  type: 'frame';
  name: string;
  /** Position in the presentation running order. */
  order: number;
}

/** Which face of an element a connector attaches to. */
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left' | 'auto';

export type ConnectorShape = 'straight' | 'curved' | 'elbow';
export type ConnectorDash = 'solid' | 'dashed' | 'dotted';

export interface ConnectorElement extends CanvasElementBase {
  type: 'connector';
  from: string;
  to: string;
  /** 'auto' re-picks the facing side as the elements move. */
  fromSide?: AnchorSide;
  toSide?: AnchorSide;
  shape?: ConnectorShape;
  dash?: ConnectorDash;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  label?: string;
  /**
   * Manual routing, in canvas coordinates. Unset means the route is derived
   * from the endpoints, so the line keeps tidying itself as elements move.
   */
  midX?: number;
  midY?: number;
  /** For curves: the point the curve is pulled through, not a control point. */
  bend?: { x: number; y: number };
  /** Superseded by arrowEnd; kept so connectors made earlier still render. */
  arrow?: boolean;
}

/**
 * One cell of a spreadsheet, showing whatever that cell holds now. The board
 * stores where the value lives, never the value.
 */
export interface SheetCellElement extends CanvasElementBase {
  type: 'sheetCell';
  spreadsheetId: string;
  sheetId: string;
  cell: string;
  /** What to call it where the value cannot be shown. */
  label?: string;
}

/** A chart from a spreadsheet, drawn from the spreadsheet's current data. */
export interface SheetChartElement extends CanvasElementBase {
  type: 'sheetChart';
  spreadsheetId: string;
  sheetId: string;
  chartId: string;
  label?: string;
}

/** A work item as a card: its key, title, status and who is on it, as they are now. */
export interface WorkItemElement extends CanvasElementBase {
  type: 'workItem';
  itemId: string;
  /** What it was called when placed, for when it cannot be looked up. */
  label?: string;
}

export type CanvasElement =
  | NoteElement
  | TextElement
  | LinkElement
  | EmbedElement
  | ImageElement
  | AudioElement
  | VideoElement
  | ShapeElement
  | MindNodeElement
  | FrameElement
  | ConnectorElement
  | SheetCellElement
  | SheetChartElement
  | WorkItemElement;

export const NOTE_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#fed7aa'];

/** Sensible starting size per element type, in canvas units. */
export const DEFAULT_SIZE: Record<CanvasElementType, { width: number; height: number }> = {
  note: { width: 200, height: 200 },
  text: { width: 260, height: 60 },
  // Document cards render real content, so they need room to be readable.
  link: { width: 320, height: 260 },
  embed: { width: 480, height: 300 },
  image: { width: 320, height: 240 },
  audio: { width: 320, height: 80 },
  video: { width: 480, height: 300 },
  shape: { width: 220, height: 160 },
  node: { width: 180, height: 64 },
  frame: { width: 960, height: 600 },
  connector: { width: 0, height: 0 },
  sheetCell: { width: 220, height: 96 },
  sheetChart: { width: 440, height: 300 },
  workItem: { width: 280, height: 120 },
};

/**
 * Whether a URL is a web page, and so safe to put in an iframe or hand to a
 * link. The URL is whatever an editor typed, or wrote into the shared document
 * directly: a `javascript:` URL in a frame runs as this app, for whoever opens
 * the canvas.
 */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Turns a shareable URL into one that can be framed, or null for anything that
 * is not a web page. Providers that block framing on their watch pages allow
 * it on a dedicated embed path.
 */
export function toEmbedUrl(raw: string): string | null {
  if (!isWebUrl(raw)) return null;
  const url = new URL(raw);
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1);
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  if (host === 'vimeo.com') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
  }
  if (host === 'loom.com' && url.pathname.startsWith('/share/')) {
    return raw.replace('/share/', '/embed/');
  }
  return raw;
}

export const CONNECTOR_COLORS = ['#8f8f9c', '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444'];

/** Fills offered for shapes. 'transparent' means no fill at all. */
export const SHAPE_FILLS = [
  'transparent',
  '#e0e7ff',
  '#cffafe',
  '#dcfce7',
  '#fef3c7',
  '#fee2e2',
  '#f3e8ff',
];

export const SHAPE_KINDS: ShapeKind[] = ['rectangle', 'ellipse', 'diamond', 'triangle'];

export const NODE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

/** Gap left between a node and its children, and between siblings. */
export const NODE_GAP_X = 90;
export const NODE_GAP_Y = 24;

/** Every node beneath `id`, depth first. Used when deleting or moving a branch. */
export function descendantsOf(id: string, elements: CanvasElement[]): string[] {
  const children = elements.filter(
    (el): el is MindNodeElement => el.type === 'node' && el.parentId === id,
  );
  return children.flatMap((child) => [child.id, ...descendantsOf(child.id, elements)]);
}

/** Points describing a shape inside a box, for the kinds drawn as polygons. */
export function shapePolygon(kind: ShapeKind, width: number, height: number): string {
  if (kind === 'diamond') {
    return `${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`;
  }
  return `${width / 2},0 ${width},${height} 0,${height}`; // triangle
}

export const ANCHOR_SIDES: Exclude<AnchorSide, 'auto'>[] = ['top', 'right', 'bottom', 'left'];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Midpoint of one face of an element. */
export function sidePoint(box: Box, side: Exclude<AnchorSide, 'auto'>): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: box.x + box.width / 2, y: box.y };
    case 'bottom':
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'left':
      return { x: box.x, y: box.y + box.height / 2 };
    case 'right':
      return { x: box.x + box.width, y: box.y + box.height / 2 };
  }
}

/** The face of `box` that points towards `toward`, used when a side is 'auto'. */
export function facingSide(box: Box, toward: { x: number; y: number }): Exclude<AnchorSide, 'auto'> {
  const dx = toward.x - (box.x + box.width / 2);
  const dy = toward.y - (box.y + box.height / 2);
  // Compare against the box aspect so wide boxes prefer their vertical faces.
  if (Math.abs(dx) * box.height > Math.abs(dy) * box.width) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

const NORMALS: Record<Exclude<AnchorSide, 'auto'>, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function resolveEndpoints(
  from: Box,
  to: Box,
  fromSide: AnchorSide = 'auto',
  toSide: AnchorSide = 'auto',
) {
  const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const s1 = fromSide === 'auto' ? facingSide(from, toCentre) : fromSide;
  const s2 = toSide === 'auto' ? facingSide(to, fromCentre) : toSide;
  return { s1, s2, p1: sidePoint(from, s1), p2: sidePoint(to, s2) };
}

export interface ConnectorRoute {
  midX?: number;
  midY?: number;
  bend?: { x: number; y: number };
}

type Point = { x: number; y: number };

const isHorizontal = (side: Exclude<AnchorSide, 'auto'>) => side === 'left' || side === 'right';

/** Control point of the quadratic whose midpoint sits exactly on `bend`. */
function controlThrough(p1: Point, bend: Point, p2: Point): Point {
  return { x: (4 * bend.x - p1.x - p2.x) / 2, y: (4 * bend.y - p1.y - p2.y) / 2 };
}

function defaultCubic(p1: Point, s1: Exclude<AnchorSide, 'auto'>, p2: Point, s2: Exclude<AnchorSide, 'auto'>) {
  const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  // Pull the handles out along each face so the curve leaves cleanly.
  const pull = Math.max(40, distance / 2);
  const n1 = NORMALS[s1];
  const n2 = NORMALS[s2];
  return {
    c1: { x: p1.x + n1.x * pull, y: p1.y + n1.y * pull },
    c2: { x: p2.x + n2.x * pull, y: p2.y + n2.y * pull },
  };
}

/** SVG path data for a connector between two resolved endpoints. */
export function connectorPath(
  p1: Point,
  s1: Exclude<AnchorSide, 'auto'>,
  p2: Point,
  s2: Exclude<AnchorSide, 'auto'>,
  shape: ConnectorShape = 'straight',
  route: ConnectorRoute = {},
): string {
  if (shape === 'straight') return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;

  if (shape === 'curved') {
    if (route.bend) {
      const c = controlThrough(p1, route.bend, p2);
      return `M ${p1.x} ${p1.y} Q ${c.x} ${c.y}, ${p2.x} ${p2.y}`;
    }
    const { c1, c2 } = defaultCubic(p1, s1, p2, s2);
    return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
  }

  // Elbow: leave each face along its own axis, then meet at an adjustable run.
  const h1 = isHorizontal(s1);
  const h2 = isHorizontal(s2);
  if (h1 && h2) {
    const mx = route.midX ?? (p1.x + p2.x) / 2;
    return `M ${p1.x} ${p1.y} L ${mx} ${p1.y} L ${mx} ${p2.y} L ${p2.x} ${p2.y}`;
  }
  if (!h1 && !h2) {
    const my = route.midY ?? (p1.y + p2.y) / 2;
    return `M ${p1.x} ${p1.y} L ${p1.x} ${my} L ${p2.x} ${my} L ${p2.x} ${p2.y}`;
  }
  if (h1) return `M ${p1.x} ${p1.y} L ${p2.x} ${p1.y} L ${p2.x} ${p2.y}`;
  return `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y} L ${p2.x} ${p2.y}`;
}

/**
 * Where to draw the routing handle, and which field a drag on it writes.
 * Returns null for routes with no freedom, such as an elbow between one
 * horizontal and one vertical face, where the single corner is determined.
 */
export function routeHandle(
  p1: Point,
  s1: Exclude<AnchorSide, 'auto'>,
  p2: Point,
  s2: Exclude<AnchorSide, 'auto'>,
  shape: ConnectorShape,
  route: ConnectorRoute = {},
): { point: Point; axis: 'x' | 'y' | 'free' } | null {
  if (shape === 'straight') {
    return { point: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, axis: 'free' };
  }

  if (shape === 'curved') {
    if (route.bend) return { point: route.bend, axis: 'free' };
    const { c1, c2 } = defaultCubic(p1, s1, p2, s2);
    // Midpoint of the cubic at t = 0.5, so grabbing the handle does not jump.
    return {
      point: {
        x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
        y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
      },
      axis: 'free',
    };
  }

  const h1 = isHorizontal(s1);
  const h2 = isHorizontal(s2);
  if (h1 && h2) {
    const mx = route.midX ?? (p1.x + p2.x) / 2;
    return { point: { x: mx, y: (p1.y + p2.y) / 2 }, axis: 'x' };
  }
  if (!h1 && !h2) {
    const my = route.midY ?? (p1.y + p2.y) / 2;
    return { point: { x: (p1.x + p2.x) / 2, y: my }, axis: 'y' };
  }
  return null;
}

export function dashArray(dash: ConnectorDash = 'solid', width = 2): string | undefined {
  if (dash === 'dashed') return `${width * 4} ${width * 3}`;
  if (dash === 'dotted') return `${width * 0.1} ${width * 2.2}`;
  return undefined;
}

/**
 * Text a canvas contributes to search, in reading order.
 *
 * `names` resolves the people tagged in that text. A canvas stores a tag as an
 * id alone, so without them a tag would be indexed as a uuid nobody will ever
 * search for; with them it reads as the name, which is what someone looking for
 * it would type.
 */
export function canvasSearchText(elements: CanvasElement[], names: Map<string, string> = new Map()): string {
  const lines: string[] = [];
  const say = (text: string) => renderCanvasMentions(text, names).trim();
  for (const el of [...elements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    switch (el.type) {
      case 'note':
      case 'text':
        if (say(el.text)) lines.push(say(el.text));
        break;
      case 'frame':
        if (say(el.name)) lines.push(`## ${say(el.name)}`);
        break;
      case 'link':
        if (el.title) lines.push(el.title);
        break;
      case 'embed':
      case 'audio':
      case 'video':
        lines.push(el.title ? `${el.title} — ${el.url}` : el.url);
        break;
      case 'shape':
        if (say(el.text ?? '')) lines.push(say(el.text ?? ''));
        break;
      case 'node':
        if (say(el.text)) lines.push(el.parentId ? `- ${say(el.text)}` : `## ${say(el.text)}`);
        break;
      case 'image':
        if (el.alt) lines.push(el.alt);
        break;
      case 'connector':
        if (say(el.label ?? '')) lines.push(say(el.label ?? ''));
        break;
      // Placeholders, which the export replaces with the spreadsheet's current values.
      case 'sheetCell':
        lines.push(sheetRefMarkdown({ kind: 'cell', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, cell: el.cell }, el.label ?? el.cell));
        break;
      case 'sheetChart':
        lines.push(sheetRefMarkdown({ kind: 'chart', spreadsheetId: el.spreadsheetId, sheetId: el.sheetId, chartId: el.chartId }, el.label ?? 'Chart'));
        break;
      case 'workItem':
        if (el.label) lines.push(el.label);
        break;
    }
  }
  return lines.join('\n\n');
}
