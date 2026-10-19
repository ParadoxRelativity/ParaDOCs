/**
 * Shape geometry for slides. Every shape is one SVG path in the element's own
 * box (0,0 to width,height), so the same outline is drawn by the stage, the
 * thumbnails, the slideshow and, later, the exporters.
 */

import type { ShapeKind } from './canvas.js';

export const SLIDE_SHAPE_KINDS = [
  'rectangle',
  'roundRect',
  'ellipse',
  'triangle',
  'diamond',
  'arrowRight',
  'arrowLeft',
  'arrowUp',
  'arrowDown',
  'callout',
  'star',
  'line',
] as const;
export type SlideShapeKind = ShapeKind | (typeof SLIDE_SHAPE_KINDS)[number];

export const SLIDE_SHAPE_LABELS: Record<SlideShapeKind, string> = {
  rectangle: 'Rectangle',
  roundRect: 'Rounded rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  diamond: 'Diamond',
  arrowRight: 'Right arrow',
  arrowLeft: 'Left arrow',
  arrowUp: 'Up arrow',
  arrowDown: 'Down arrow',
  callout: 'Callout',
  star: 'Star',
  line: 'Line',
};

const n = (value: number) => Math.round(value * 100) / 100;
const poly = (points: [number, number][]) => `M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;

/** A right-pointing arrow in a w x h box; the others are this turned. */
function arrowRight(w: number, h: number): [number, number][] {
  const shaft = h * 0.3;
  const head = Math.min(w * 0.45, h * 0.7);
  return [
    [0, shaft],
    [w - head, shaft],
    [w - head, 0],
    [w, h / 2],
    [w - head, h],
    [w - head, h - shaft],
    [0, h - shaft],
  ];
}

export interface ShapeGeometry {
  /** SVG path data. */
  d: string;
  /** A line has no inside to fill. */
  open: boolean;
}

export function shapeGeometry(kind: SlideShapeKind, width: number, height: number): ShapeGeometry {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  switch (kind) {
    case 'roundRect': {
      const r = Math.min(w, h) * 0.18;
      return { open: false, d: `M${n(r)} 0H${n(w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w)} ${n(r)}V${n(h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(w - r)} ${n(h)}H${n(r)}A${n(r)} ${n(r)} 0 0 1 0 ${n(h - r)}V${n(r)}A${n(r)} ${n(r)} 0 0 1 ${n(r)} 0Z` };
    }
    case 'ellipse':
      return { open: false, d: `M0 ${n(h / 2)}A${n(w / 2)} ${n(h / 2)} 0 1 1 ${n(w)} ${n(h / 2)}A${n(w / 2)} ${n(h / 2)} 0 1 1 0 ${n(h / 2)}Z` };
    case 'triangle':
      return { open: false, d: poly([[w / 2, 0], [w, h], [0, h]]) };
    case 'diamond':
      return { open: false, d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
    case 'arrowRight':
      return { open: false, d: poly(arrowRight(w, h)) };
    case 'arrowLeft':
      return { open: false, d: poly(arrowRight(w, h).map(([x, y]) => [w - x, y] as [number, number])) };
    case 'arrowDown':
      return { open: false, d: poly(arrowRight(h, w).map(([x, y]) => [y, x] as [number, number])) };
    case 'arrowUp':
      return { open: false, d: poly(arrowRight(h, w).map(([x, y]) => [y, h - x] as [number, number])) };
    case 'callout': {
      // A speech bubble: the box takes the top four fifths, the tail hangs from its lower left.
      const body = h * 0.8;
      return { open: false, d: poly([[0, 0], [w, 0], [w, body], [w * 0.4, body], [w * 0.2, h], [w * 0.2, body], [0, body]]) };
    }
    case 'star': {
      const points: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 0.5 : 0.2;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        points.push([w / 2 + Math.cos(angle) * radius * w, h / 2 + Math.sin(angle) * radius * h]);
      }
      return { open: false, d: poly(points) };
    }
    case 'line':
      return { open: true, d: `M0 ${n(h / 2)}L${n(w)} ${n(h / 2)}` };
    case 'rectangle':
    default:
      return { open: false, d: `M0 0H${n(w)}V${n(h)}H0Z` };
  }
}

/** Where text sits inside a shape, as fractions of its box (a triangle's text lives in its lower half). */
export function shapeTextInset(kind: SlideShapeKind): { left: number; top: number; right: number; bottom: number } {
  switch (kind) {
    case 'triangle':
      return { left: 0.25, top: 0.4, right: 0.25, bottom: 0 };
    case 'diamond':
      return { left: 0.2, top: 0.2, right: 0.2, bottom: 0.2 };
    case 'ellipse':
      return { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };
    case 'callout':
      return { left: 0, top: 0, right: 0, bottom: 0.2 };
    case 'star':
      return { left: 0.25, top: 0.3, right: 0.25, bottom: 0.2 };
    case 'arrowRight':
      return { left: 0, top: 0.3, right: 0.2, bottom: 0.3 };
    case 'arrowLeft':
      return { left: 0.2, top: 0.3, right: 0, bottom: 0.3 };
    case 'arrowUp':
      return { left: 0.3, top: 0.25, right: 0.3, bottom: 0 };
    case 'arrowDown':
      return { left: 0.3, top: 0, right: 0.3, bottom: 0.25 };
    default:
      return { left: 0, top: 0, right: 0, bottom: 0 };
  }
}
