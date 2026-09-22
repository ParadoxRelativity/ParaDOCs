import type { CanvasElement } from '@paradocs/shared';

export type Alignment = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';

type Box = Pick<CanvasElement, 'id' | 'x' | 'y' | 'width' | 'height'>;
type Patch = { id: string; patch: Partial<CanvasElement> };

/** Lines boxes up against the edge (or centre line) of the space they share. */
export function alignBoxes(boxes: Box[], alignment: Alignment): Patch[] {
  if (boxes.length < 2) return [];
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return boxes.map((b) => {
    switch (alignment) {
      case 'left':
        return { id: b.id, patch: { x: left } };
      case 'centerX':
        return { id: b.id, patch: { x: (left + right) / 2 - b.width / 2 } };
      case 'right':
        return { id: b.id, patch: { x: right - b.width } };
      case 'top':
        return { id: b.id, patch: { y: top } };
      case 'centerY':
        return { id: b.id, patch: { y: (top + bottom) / 2 - b.height / 2 } };
      case 'bottom':
        return { id: b.id, patch: { y: bottom - b.height } };
    }
  });
}

/**
 * Spaces boxes so the gaps between them are equal, keeping the first and last
 * where they are. Needs three: with two there is only one gap.
 */
export function distributeBoxes(boxes: Box[], axis: 'x' | 'y'): Patch[] {
  if (boxes.length < 3) return [];
  const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...boxes].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[axis] + last[size] - first[axis];
  const occupied = sorted.reduce((sum, b) => sum + b[size], 0);
  const gap = (span - occupied) / (sorted.length - 1);
  let cursor = first[axis];
  return sorted.map((b) => {
    const patch = { id: b.id, patch: { [axis]: cursor } as Partial<CanvasElement> };
    cursor += b[size] + gap;
    return patch;
  });
}

// --- snapping ---------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A line drawn while dragging to show what has lined up: vertical ('x') at
 * `at` from `from` to `to` down the page, or horizontal ('y') across it.
 */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/** The lines a box can line up by on one axis: its two edges and its centre. */
function lines(r: Rect, axis: 'x' | 'y') {
  return axis === 'x' ? [r.x, r.x + r.width / 2, r.x + r.width] : [r.y, r.y + r.height / 2, r.y + r.height];
}

/** The smallest shift, within the threshold, that puts one of `from` exactly on one of `targets`. */
function nearest(from: number[], targets: number[], threshold: number): number {
  let best = 0;
  let bestDistance = threshold;
  for (const line of from) {
    for (const target of targets) {
      const distance = Math.abs(target - line);
      if (distance <= bestDistance) {
        best = target - line;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Guides for every edge or centre of `box` that other boxes share exactly. */
export function guidesFor(box: Rect, others: Rect[]): Guide[] {
  const guides: Guide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const cross = axis === 'x' ? 'y' : 'x';
    const size = axis === 'x' ? 'height' : 'width';
    for (const at of lines(box, axis)) {
      let from = box[cross];
      let to = box[cross] + box[size];
      let matched = false;
      for (const other of others) {
        if (!lines(other, axis).some((line) => Math.abs(line - at) < 0.5)) continue;
        matched = true;
        from = Math.min(from, other[cross]);
        to = Math.max(to, other[cross] + other[size]);
      }
      if (matched) guides.push({ axis, at, from, to });
    }
  }
  return guides;
}

/**
 * Nudges a box being dragged so an edge or its centre lands on another box's
 * edge or centre when it is within `threshold`, and says what now lines up.
 */
export function snapMove(moving: Rect, others: Rect[], threshold: number) {
  const dx = nearest(lines(moving, 'x'), others.flatMap((o) => lines(o, 'x')), threshold);
  const dy = nearest(lines(moving, 'y'), others.flatMap((o) => lines(o, 'y')), threshold);
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return { dx, dy, guides: guidesFor(snapped, others) };
}

/**
 * The same for a resize: only the edges the handle moves are snapped, so the
 * opposite corner stays exactly where it was.
 */
export function snapResize(box: Rect, corner: 'nw' | 'ne' | 'sw' | 'se', others: Rect[], threshold: number, min = 40) {
  const xs = others.flatMap((o) => lines(o, 'x'));
  const ys = others.flatMap((o) => lines(o, 'y'));
  const next = { ...box };
  if (corner.includes('e')) {
    next.width = Math.max(min, next.width + nearest([box.x + box.width], xs, threshold));
  } else {
    const shift = nearest([box.x], xs, threshold);
    if (box.width - shift >= min) {
      next.x += shift;
      next.width -= shift;
    }
  }
  if (corner.includes('s')) {
    next.height = Math.max(min, next.height + nearest([box.y + box.height], ys, threshold));
  } else {
    const shift = nearest([box.y], ys, threshold);
    if (box.height - shift >= min) {
      next.y += shift;
      next.height -= shift;
    }
  }
  return { box: next, guides: guidesFor(next, others) };
}

/** The smallest box around all of these. */
export function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

// --- groups -------------------------------------------------------------------

/** Each grouped element's id mapped to every member of its group, itself included. */
export function groupIndex(elements: CanvasElement[]): Map<string, string[]> {
  const byGroup = new Map<string, string[]>();
  for (const el of elements) {
    if (!el.groupId || el.type === 'connector') continue;
    const members = byGroup.get(el.groupId) ?? [];
    members.push(el.id);
    byGroup.set(el.groupId, members);
  }
  const index = new Map<string, string[]>();
  for (const members of byGroup.values()) {
    // A group whose other members were deleted is no group at all.
    if (members.length < 2) continue;
    for (const id of members) index.set(id, members);
  }
  return index;
}

/** The ids plus every other member of any group they belong to. */
export function withGroups(ids: Iterable<string>, index: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    for (const member of index.get(id) ?? []) out.add(member);
  }
  return out;
}

/**
 * Names for the palette colours, so a swatch can be told apart without seeing
 * it: a screen reader says "Yellow", not "Note colour" six times over.
 */
const COLOR_NAMES: Record<string, string> = {
  transparent: 'No fill',
  '#fde68a': 'Yellow',
  '#bbf7d0': 'Green',
  '#bfdbfe': 'Blue',
  '#fbcfe8': 'Pink',
  '#e9d5ff': 'Purple',
  '#fed7aa': 'Orange',
  '#8f8f9c': 'Grey',
  '#6366f1': 'Indigo',
  '#0ea5e9': 'Sky blue',
  '#10b981': 'Green',
  '#f59e0b': 'Amber',
  '#ef4444': 'Red',
  '#ec4899': 'Pink',
  '#e0e7ff': 'Pale indigo',
  '#cffafe': 'Pale cyan',
  '#dcfce7': 'Pale green',
  '#fef3c7': 'Pale amber',
  '#fee2e2': 'Pale red',
  '#f3e8ff': 'Pale purple',
};

export function colorName(color: string): string {
  return COLOR_NAMES[color.toLowerCase()] ?? color;
}
