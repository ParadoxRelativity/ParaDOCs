import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import {
  CANVAS_ELEMENTS,
  DEFAULT_SIZE,
  descendantsOf,
  type CanvasElement,
  type CanvasElementType,
} from '@paradocs/shared';
import { randomId } from './util';

/**
 * React view over the canvas elements stored in a document's Y.Doc.
 *
 * Each element is its own nested Y.Map, so concurrent edits to different
 * elements — or to different fields of one element — merge instead of one
 * writer overwriting the other's whole object.
 */
export function useCanvasElements(ydoc: Y.Doc) {
  const map = useMemo(() => ydoc.getMap<Y.Map<unknown>>(CANVAS_ELEMENTS), [ydoc]);
  const [elements, setElements] = useState<CanvasElement[]>([]);

  useEffect(() => {
    const read = () => {
      const next: CanvasElement[] = [];
      map.forEach((value) => {
        if (!(value instanceof Y.Map)) return;
        const el = value.toJSON() as CanvasElement;
        if (el && el.id && el.type) next.push(el);
      });
      // Frames paint behind everything so their contents stay clickable.
      next.sort((a, b) => {
        if (a.type === 'frame' && b.type !== 'frame') return -1;
        if (b.type === 'frame' && a.type !== 'frame') return 1;
        return (a.z ?? 0) - (b.z ?? 0);
      });
      setElements(next);
    };
    read();
    map.observeDeep(read);
    return () => map.unobserveDeep(read);
  }, [map]);

  const create = useCallback(
    (type: CanvasElementType, props: Partial<CanvasElement> & { x: number; y: number }) => {
      const id = randomId();
      const size = DEFAULT_SIZE[type];
      const highest = Math.max(0, ...[...map.values()].map((v) => Number(v.get('z') ?? 0)));
      const element = new Y.Map<unknown>();
      const initial: Record<string, unknown> = {
        width: size.width,
        height: size.height,
        ...props,
        id,
        type,
        z: highest + 1,
      };
      // One transaction so collaborators see the element appear whole.
      ydoc.transact(() => {
        for (const [key, value] of Object.entries(initial)) {
          if (value !== undefined) element.set(key, value);
        }
        map.set(id, element);
      });
      return id;
    },
    [map, ydoc],
  );

  const update = useCallback(
    (id: string, patch: Partial<CanvasElement>) => {
      const element = map.get(id);
      if (!element) return;
      ydoc.transact(() => {
        for (const [key, value] of Object.entries(patch)) {
          // An explicit undefined clears the field, which is how routing
          // overrides are reset; omitting the key leaves it untouched.
          if (value === undefined) element.delete(key);
          else element.set(key, value);
        }
      });
    },
    [map, ydoc],
  );

  /** Applies several patches in one transaction, for a completed drag or resize. */
  const updateMany = useCallback(
    (updates: { id: string; patch: Partial<CanvasElement> }[]) => {
      ydoc.transact(() => {
        for (const { id, patch } of updates) {
          const element = map.get(id);
          if (!element) continue;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) element.delete(key);
            else element.set(key, value);
          }
        }
      });
    },
    [map, ydoc],
  );

  const remove = useCallback(
    (ids: string[]) => {
      // Deleting a mind-map node takes its branch with it; leaving orphans
      // behind would strand children with no route back to a root.
      const current: CanvasElement[] = [];
      map.forEach((value) => {
        if (value instanceof Y.Map) current.push(value.toJSON() as CanvasElement);
      });
      const withBranches = new Set(ids);
      for (const id of ids) {
        if (current.find((el) => el.id === id)?.type === 'node') {
          for (const child of descendantsOf(id, current)) withBranches.add(child);
        }
      }

      ydoc.transact(() => {
        for (const id of withBranches) {
          map.delete(id);
          // Connectors dangling from a deleted element would draw to nowhere.
          map.forEach((value, key) => {
            if (value.get('type') !== 'connector') return;
            if (value.get('from') === id || value.get('to') === id) map.delete(key);
          });
        }
      });
    },
    [map, ydoc],
  );

  const bringToFront = useCallback(
    (id: string) => {
      const highest = Math.max(0, ...[...map.values()].map((v) => Number(v.get('z') ?? 0)));
      update(id, { z: highest + 1 } as Partial<CanvasElement>);
    },
    [map, update],
  );

  return { elements, create, update, updateMany, remove, bringToFront };
}

/** Axis-aligned bounds of a set of elements, or null when empty. */
export function boundsOf(elements: CanvasElement[]) {
  const boxes = elements.filter((el) => el.type !== 'connector');
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((e) => e.x));
  const minY = Math.min(...boxes.map((e) => e.y));
  const maxX = Math.max(...boxes.map((e) => e.x + e.width));
  const maxY = Math.max(...boxes.map((e) => e.y + e.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Where a connector line should meet an element: its centre, clipped to the edge. */
export function anchorPoint(from: CanvasElement, toward: { x: number; y: number }) {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfW = from.width / 2;
  const halfH = from.height / 2;
  // Scale the direction vector until it touches the box edge.
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}
