/**
 * Canvas content on slides: a canvas's frames become a deck, and a selection
 * copied from a board lands on a slide.
 *
 * Both are the same move: take the elements inside a region of the board, scale
 * the region to fit the slide and centre it. Elements that mean the same on a
 * slide as on a board (pictures, live spreadsheet cells and charts, work items,
 * document cards) are copied as they are; notes, text and mind-map nodes become
 * the slide's own shapes and text boxes.
 */

import type * as Y from 'yjs';
import { randomUuid } from './uuid.js';
import {
  NODE_COLORS,
  NOTE_COLORS,
  type CanvasElement,
  type ConnectorElement,
  type FrameElement,
} from './canvas.js';
import { createSlide, setSlideElement, type SlideElement, type SlideSize } from './slides.js';

export interface BoardRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Never blow a small selection up more than this, so a lone note does not fill the slide. */
const MAX_PASTE_SCALE = 3;

const clampSize = (n: number) => Math.min(Math.max(Math.round(n), 8), 400);

function overlaps(el: CanvasElement, region: BoardRegion): boolean {
  return (
    el.x < region.x + region.width &&
    el.x + el.width > region.x &&
    el.y < region.y + region.height &&
    el.y + el.height > region.y
  );
}

/** The frames of a board in running order: by their number, then top to bottom and left to right. */
export function orderedFrames(elements: CanvasElement[]): FrameElement[] {
  return elements
    .filter((el): el is FrameElement => el.type === 'frame')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.y - b.y || a.x - b.x);
}

/** The box around a set of elements (connectors have none of their own). */
export function boardBounds(elements: CanvasElement[]): BoardRegion | null {
  const boxes = elements.filter((el) => el.type !== 'connector');
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((el) => el.x));
  const y = Math.min(...boxes.map((el) => el.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((el) => el.x + el.width)) - x,
    height: Math.max(...boxes.map((el) => el.y + el.height)) - y,
  };
}

/**
 * The elements of a board that lie in `region`, as slide elements fitted to a
 * slide of `size`. With `limitScale` the region is not enlarged past a few
 * times its size (for a pasted selection; a frame is always fitted exactly).
 */
export function canvasElementsToSlide(
  source: CanvasElement[],
  region: BoardRegion,
  size: SlideSize,
  options: { limitScale?: boolean; makeId?: () => string } = {},
): SlideElement[] {
  const makeId = options.makeId ?? (() => randomUuid());
  const fit = Math.min(size.width / Math.max(region.width, 1), size.height / Math.max(region.height, 1));
  const scale = options.limitScale ? Math.min(fit, MAX_PASTE_SCALE) : fit;
  const offsetX = (size.width - region.width * scale) / 2 - region.x * scale;
  const offsetY = (size.height - region.height * scale) / 2 - region.y * scale;
  const px = (x: number) => Math.round(x * scale + offsetX);
  const py = (y: number) => Math.round(y * scale + offsetY);

  const inside = source.filter((el) => el.type !== 'frame' && el.type !== 'connector' && overlaps(el, region));
  const ids = new Map(inside.map((el) => [el.id, makeId()]));
  const out: SlideElement[] = [];
  let z = 1;

  for (const el of inside) {
    const box = {
      id: ids.get(el.id)!,
      x: px(el.x),
      y: py(el.y),
      width: Math.max(Math.round(el.width * scale), 1),
      height: Math.max(Math.round(el.height * scale), 1),
      z: z++,
    };
    const rest: Record<string, unknown> = { ...el };
    for (const key of ['id', 'x', 'y', 'width', 'height', 'z', 'groupId', 'createdBy']) delete rest[key];
    switch (el.type) {
      case 'note':
        out.push({
          ...box,
          type: 'shape',
          shape: 'rectangle',
          text: el.text,
          fill: el.color ?? NOTE_COLORS[0],
          stroke: 'transparent',
          strokeWidth: 0,
          fontSize: clampSize(18 * scale),
        } as SlideElement);
        break;
      case 'text':
        out.push({
          ...box,
          type: 'richText',
          paragraphs: el.text.split('\n').map((line) => ({ runs: [{ text: line }] })),
          fontSize: clampSize((el.fontSize ?? 18) * scale),
          ...(el.color ? { color: el.color } : {}),
        } as SlideElement);
        break;
      case 'node':
        out.push({
          ...box,
          type: 'shape',
          shape: 'roundRect',
          text: el.text,
          fill: el.color ?? NODE_COLORS[0],
          stroke: 'transparent',
          strokeWidth: 0,
          fontSize: clampSize(16 * scale),
        } as SlideElement);
        break;
      case 'shape':
        out.push({ ...rest, ...box, ...(el.text ? { fontSize: clampSize(18 * scale) } : {}) } as unknown as SlideElement);
        break;
      default:
        // Pictures, media, embeds, document cards, live spreadsheet and work item cards.
        out.push({ ...rest, ...box } as unknown as SlideElement);
    }
  }

  for (const c of source) {
    if (c.type !== 'connector') continue;
    const connector: ConnectorElement = c;
    if (!ids.has(connector.from) || !ids.has(connector.to)) continue;
    const rest: Record<string, unknown> = { ...connector };
    for (const key of ['id', 'groupId', 'createdBy']) delete rest[key];
    out.push({
      ...rest,
      id: makeId(),
      from: ids.get(connector.from)!,
      to: ids.get(connector.to)!,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      z: z++,
      ...(connector.midX !== undefined ? { midX: px(connector.midX) } : {}),
      ...(connector.midY !== undefined ? { midY: py(connector.midY) } : {}),
      ...(connector.bend ? { bend: { x: px(connector.bend.x), y: py(connector.bend.y) } } : {}),
    } as unknown as SlideElement);
  }
  // A mind-map branch is a link to its parent; on a slide it is a connector.
  for (const el of inside) {
    if (el.type !== 'node' || !el.parentId || !ids.has(el.parentId)) continue;
    out.push({
      id: makeId(),
      type: 'connector',
      from: ids.get(el.parentId)!,
      to: ids.get(el.id)!,
      shape: 'curved',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      z: z++,
    } as unknown as SlideElement);
  }
  return out;
}

export interface FrameSlide {
  name: string;
  elements: SlideElement[];
}

/** One slide per frame, in frame order, each holding what lies inside its frame. */
export function canvasFramesToSlides(source: CanvasElement[], size: SlideSize): FrameSlide[] {
  return orderedFrames(source).map((frame) => ({
    name: frame.name,
    elements: canvasElementsToSlide(source, frame, size),
  }));
}

/** Adds the slides to a deck, each with its elements, in one transaction. Returns the new slide ids. */
export function writeFrameSlides(doc: Y.Doc, slides: FrameSlide[]): string[] {
  const ids: string[] = [];
  doc.transact(() => {
    for (const slide of slides) {
      const id = createSlide(doc);
      ids.push(id);
      for (const element of slide.elements) setSlideElement(doc, id, element);
    }
  });
  return ids;
}
