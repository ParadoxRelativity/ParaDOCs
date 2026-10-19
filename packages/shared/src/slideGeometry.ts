/**
 * Geometry for editing slide elements: resizing and rotating boxes that may
 * already be turned, and layering. Pure functions over plain boxes, so the
 * stage stays a thin layer of pointer handling and the maths can be tested
 * without a browser.
 */

export interface SlideBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the centre. */
  rotation?: number;
}

/** The eight resize handles, named by the side or corner they sit on. */
export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const MIN_ELEMENT_SIZE = 24;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Rotates a vector clockwise by `degrees` (screen coordinates: y grows downward). */
function rotate(x: number, y: number, degrees: number) {
  const r = toRadians(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** A rotation as 0 <= degrees < 360. */
export function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * The box after dragging `handle` by (dx, dy), given in slide units on screen.
 * The drag is taken into the box's own turned axes, and the side opposite the
 * handle stays where it was on screen, so a rotated box grows from its far
 * edge rather than drifting. `keepAspect` holds the ratio on corner handles.
 */
export function resizeBox(
  start: SlideBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  { keepAspect = false, min = MIN_ELEMENT_SIZE }: { keepAspect?: boolean; min?: number } = {},
): SlideBox {
  const rotation = start.rotation ?? 0;
  const local = rotate(dx, dy, -rotation);
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  let width = start.width + (east ? local.x : west ? -local.x : 0);
  let height = start.height + (south ? local.y : north ? -local.y : 0);
  if (keepAspect && (east || west) && (north || south)) {
    const ratio = start.width / start.height;
    // Follow whichever axis the pointer moved further along.
    if (Math.abs(width - start.width) / start.width >= Math.abs(height - start.height) / start.height) height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(min, width);
  height = Math.max(min, height);

  // The anchor is the point opposite the handle, in the box's own frame
  // relative to its centre; it must land on the same screen point afterwards.
  const ax = east ? -start.width / 2 : west ? start.width / 2 : 0;
  const ay = south ? -start.height / 2 : north ? start.height / 2 : 0;
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  const anchor = rotate(ax, ay, rotation);
  const anchorX = cx + anchor.x;
  const anchorY = cy + anchor.y;
  const nax = east ? -width / 2 : west ? width / 2 : 0;
  const nay = south ? -height / 2 : north ? height / 2 : 0;
  const shifted = rotate(nax, nay, rotation);
  const ncx = anchorX - shifted.x;
  const ncy = anchorY - shifted.y;
  return { x: ncx - width / 2, y: ncy - height / 2, width, height, rotation: start.rotation };
}

/**
 * The rotation that points a box's top at `pointer`, about its centre.
 * `step` snaps to multiples of itself (15 for a held Shift).
 */
export function rotationToward(box: SlideBox, pointer: { x: number; y: number }, step = 0): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let degrees = (Math.atan2(pointer.y - cy, pointer.x - cx) * 180) / Math.PI + 90;
  if (step > 0) degrees = Math.round(degrees / step) * step;
  return Math.round(normalizeRotation(degrees) * 100) / 100;
}

/** The box around a turned box, as it is seen: what snapping and alignment should treat it as. */
export function visibleBounds(box: SlideBox): { x: number; y: number; width: number; height: number } {
  const rotation = box.rotation ?? 0;
  if (!rotation) return { x: box.x, y: box.y, width: box.width, height: box.height };
  const r = toRadians(rotation);
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const width = box.width * cos + box.height * sin;
  const height = box.width * sin + box.height * cos;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward';

/**
 * Renumbers paint order after moving `ids` as asked, returning only the
 * elements whose `z` changed. Members of a move keep their order among
 * themselves. Everything is renumbered 0..n, which also repairs ties.
 */
export function reorderZ(elements: { id: string; z: number }[], ids: Set<string>, how: ZOrder): { id: string; z: number }[] {
  const sorted = [...elements].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  if (!sorted.some((el) => ids.has(el.id))) return [];
  const moving = sorted.filter((el) => ids.has(el.id));
  let order: { id: string; z: number }[];
  if (how === 'front') order = [...sorted.filter((el) => !ids.has(el.id)), ...moving];
  else if (how === 'back') order = [...moving, ...sorted.filter((el) => !ids.has(el.id))];
  else {
    order = [...sorted];
    if (how === 'forward') {
      for (let i = order.length - 2; i >= 0; i--) {
        if (ids.has(order[i].id) && !ids.has(order[i + 1].id)) [order[i], order[i + 1]] = [order[i + 1], order[i]];
      }
    } else {
      for (let i = 1; i < order.length; i++) {
        if (ids.has(order[i].id) && !ids.has(order[i - 1].id)) [order[i], order[i - 1]] = [order[i - 1], order[i]];
      }
    }
  }
  const changes: { id: string; z: number }[] = [];
  order.forEach((el, index) => {
    if (el.z !== index) changes.push({ id: el.id, z: index });
  });
  return changes;
}
