import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  CANVAS_ELEMENTS,
  DEFAULT_SIZE,
  descendantsOf,
  type CanvasElement,
  type CanvasElementType,
  type ConnectorElement,
} from '@paradocs/shared';
import { randomId } from './util';

/** Changes made closer together than this undo as one step, so typing is not undone a letter at a time. */
const UNDO_CAPTURE_MS = 400;

/**
 * React view over the canvas elements stored in a document's Y.Doc.
 *
 * Each element is its own nested Y.Map, so concurrent edits to different
 * elements — or to different fields of one element — merge instead of one
 * writer overwriting the other's whole object.
 *
 * Every write is tagged with an origin private to this hook, so undo and redo
 * step back through this person's own changes and never through a
 * collaborator's.
 */
export function useCanvasElements(ydoc: Y.Doc) {
  const map = useMemo(() => ydoc.getMap<Y.Map<unknown>>(CANVAS_ELEMENTS), [ydoc]);
  const origin = useMemo(() => ({ canvas: 'local' }), []);
  // Made in an effect rather than a memo: a destroyed manager stops tracking,
  // and a remount (StrictMode does one) must get a live one back.
  const undoManager = useRef<Y.UndoManager | null>(null);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    // An element whose fields have not changed keeps its object, so views that
    // compare by reference skip it when something else on the board moves.
    let cache = new Map<string, { json: string; element: CanvasElement }>();
    const read = () => {
      const next: CanvasElement[] = [];
      const nextCache = new Map<string, { json: string; element: CanvasElement }>();
      map.forEach((value) => {
        if (!(value instanceof Y.Map)) return;
        const el = value.toJSON() as CanvasElement;
        if (!el || !el.id || !el.type) return;
        const json = JSON.stringify(el);
        const previous = cache.get(el.id);
        const element = previous && previous.json === json ? previous.element : el;
        nextCache.set(el.id, { json, element });
        next.push(element);
      });
      cache = nextCache;
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

  useEffect(() => {
    const manager = new Y.UndoManager(map, { trackedOrigins: new Set([origin]), captureTimeout: UNDO_CAPTURE_MS });
    undoManager.current = manager;
    const sync = () =>
      setHistory({ canUndo: manager.undoStack.length > 0, canRedo: manager.redoStack.length > 0 });
    manager.on('stack-item-added', sync);
    manager.on('stack-item-popped', sync);
    manager.on('stack-cleared', sync);
    sync();
    return () => {
      manager.destroy();
      if (undoManager.current === manager) undoManager.current = null;
    };
  }, [map, origin]);

  const highestZ = useCallback(
    () => Math.max(0, ...[...map.values()].map((v) => Number(v.get('z') ?? 0))),
    [map],
  );

  const create = useCallback(
    (type: CanvasElementType, props: Partial<CanvasElement> & { x: number; y: number }) => {
      const id = randomId();
      const size = DEFAULT_SIZE[type];
      const element = new Y.Map<unknown>();
      const initial: Record<string, unknown> = {
        width: size.width,
        height: size.height,
        ...props,
        id,
        type,
        z: highestZ() + 1,
      };
      // A new element is its own undo step, not the tail of whatever came before.
      undoManager.current?.stopCapturing();
      // One transaction so collaborators see the element appear whole.
      ydoc.transact(() => {
        for (const [key, value] of Object.entries(initial)) {
          if (value !== undefined) element.set(key, value);
        }
        map.set(id, element);
      }, origin);
      return id;
    },
    [map, ydoc, origin, highestZ],
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
      }, origin);
    },
    [map, ydoc, origin],
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
      }, origin);
    },
    [map, ydoc, origin],
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

      undoManager.current?.stopCapturing();
      ydoc.transact(() => {
        for (const id of withBranches) {
          map.delete(id);
          // Connectors dangling from a deleted element would draw to nowhere.
          map.forEach((value, key) => {
            if (value.get('type') !== 'connector') return;
            if (value.get('from') === id || value.get('to') === id) map.delete(key);
          });
        }
      }, origin);
    },
    [map, ydoc, origin],
  );

  /**
   * Adds copies of elements, shifted by an offset, and returns the new ids.
   * Connectors come along only when both their ends do, and a copied mind-map
   * node keeps its parent when that parent was copied too, or is still on the
   * board, so a duplicated child lands as a sibling.
   */
  const insertCopies = useCallback(
    (source: CanvasElement[], dx: number, dy: number) => {
      const ids = new Map(source.map((el) => [el.id, randomId()]));
      // Copies of a group form a new group of their own; a lone member copied
      // out of a group is not in one.
      const groupSizes = new Map<string, number>();
      for (const el of source) {
        if (el.groupId) groupSizes.set(el.groupId, (groupSizes.get(el.groupId) ?? 0) + 1);
      }
      const groups = new Map([...groupSizes].filter(([, size]) => size > 1).map(([id]) => [id, randomId()]));
      let z = highestZ();
      const created: string[] = [];
      undoManager.current?.stopCapturing();
      ydoc.transact(() => {
        // Boxes first, then connectors, so paint order matches the original.
        const ordered = [...source].sort((a, b) => Number(a.type === 'connector') - Number(b.type === 'connector'));
        for (const original of ordered) {
          const copy: Record<string, unknown> = {
            ...original,
            id: ids.get(original.id),
            z: ++z,
            groupId: original.groupId ? groups.get(original.groupId) : undefined,
          };
          if (original.type === 'connector') {
            const connector = original as ConnectorElement;
            if (!ids.has(connector.from) || !ids.has(connector.to)) continue;
            copy.from = ids.get(connector.from);
            copy.to = ids.get(connector.to);
            if (connector.midX !== undefined) copy.midX = connector.midX + dx;
            if (connector.midY !== undefined) copy.midY = connector.midY + dy;
            if (connector.bend) copy.bend = { x: connector.bend.x + dx, y: connector.bend.y + dy };
          } else {
            copy.x = original.x + dx;
            copy.y = original.y + dy;
          }
          if (original.type === 'node' && original.parentId) {
            if (ids.has(original.parentId)) copy.parentId = ids.get(original.parentId);
            else if (!map.has(original.parentId)) delete copy.parentId;
          }
          const element = new Y.Map<unknown>();
          for (const [key, value] of Object.entries(copy)) {
            if (value !== undefined) element.set(key, value);
          }
          map.set(copy.id as string, element);
          created.push(copy.id as string);
        }
      }, origin);
      return created;
    },
    [map, ydoc, origin, highestZ],
  );

  /** Moves elements above everything else, keeping their order among themselves. */
  const bringToFront = useCallback(
    (ids: string[]) => {
      let z = highestZ();
      const ordered = ids
        .map((id) => ({ id, z: Number(map.get(id)?.get('z') ?? 0) }))
        .sort((a, b) => a.z - b.z);
      updateMany(ordered.map(({ id }) => ({ id, patch: { z: ++z } as Partial<CanvasElement> })));
    },
    [map, updateMany, highestZ],
  );

  /** Moves elements beneath everything else, keeping their order among themselves. */
  const sendToBack = useCallback(
    (ids: string[]) => {
      let z = Math.min(0, ...[...map.values()].map((v) => Number(v.get('z') ?? 0)));
      const ordered = ids
        .map((id) => ({ id, z: Number(map.get(id)?.get('z') ?? 0) }))
        .sort((a, b) => b.z - a.z);
      updateMany(ordered.map(({ id }) => ({ id, patch: { z: --z } as Partial<CanvasElement> })));
    },
    [map, updateMany],
  );

  const undo = useCallback(() => void undoManager.current?.undo(), []);
  const redo = useCallback(() => void undoManager.current?.redo(), []);
  /** Ends the current undo step, so the next change starts a new one. */
  const stopCapturing = useCallback(() => undoManager.current?.stopCapturing(), []);

  return {
    elements,
    create,
    update,
    updateMany,
    remove,
    insertCopies,
    bringToFront,
    sendToBack,
    undo,
    redo,
    stopCapturing,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  };
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
