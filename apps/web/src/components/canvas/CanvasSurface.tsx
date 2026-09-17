import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANCHOR_SIDES,
  connectorPath,
  resolveEndpoints,
  routeHandle,
  sidePoint,
  type AnchorSide,
  type CanvasElement,
  type ConnectorElement,
  type FrameElement,
  type MindNodeElement,
  type ShapeKind,
  type WorkspaceMember,
} from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import CanvasElementView from './CanvasElementView';
import Connectors from './Connectors';

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface Props {
  elements: CanvasElement[];
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  editable: boolean;
  /** Who can be tagged in an element's text, and whose names tags resolve to. */
  members: WorkspaceMember[];
  /** When on, elements sprout anchor ports and dragging between them connects. */
  connectorTool: boolean;
  /** When set, dragging on the board draws a shape of this kind. */
  shapeTool: ShapeKind | null;
  onDrawShape: (rect: { x: number; y: number; width: number; height: number }) => void;
  /**
   * The size of an element waiting to be placed. While set, an outline of it
   * follows the pointer and the next click on the board places it there.
   */
  placing: { width: number; height: number } | null;
  onPlace: (point: { x: number; y: number }) => void;
  onConnect: (
    from: { id: string; side: AnchorSide },
    to: { id: string; side: AnchorSide },
  ) => void;
  onUpdate: (id: string, patch: Partial<CanvasElement>) => void;
  /** Called once per gesture, so a drag is a single undoable change. */
  onCommit: (updates: { id: string; patch: Partial<CanvasElement> }[]) => void;
  onBringToFront: (id: string) => void;
  onOpenDocument: (documentId: string) => void;
  dark: boolean;
  onDeleteSelection: () => void;
  onCreateNoteAt: (point: { x: number; y: number }) => void;
  /** Adds a child under a mind-map node; works at any depth. */
  onAddChild: (parentId: string) => void;
  /** Set by the editor to open a freshly created element for typing. */
  editRequestId: string | null;
  /** Files pasted or dropped onto the board, with the drop point in canvas units. */
  onFiles: (files: File[], point: { x: number; y: number }) => void;
  /** The pointer's position in canvas units as it moves, and null when it leaves the board. */
  onPointer?: (point: { x: number; y: number } | null) => void;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

export function toCanvasPoint(viewport: Viewport, clientX: number, clientY: number, rect: DOMRect) {
  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale,
  };
}

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | {
      kind: 'move';
      startX: number;
      startY: number;
      origins: Map<string, { x: number; y: number }>;
      moved: boolean;
    }
  | {
      kind: 'resize';
      id: string;
      startX: number;
      startY: number;
      origin: { width: number; height: number };
      moved: boolean;
    }
  | { kind: 'marquee'; startX: number; startY: number }
  | { kind: 'draw'; startX: number; startY: number }
  | {
      kind: 'route';
      connector: ConnectorElement;
      axis: 'x' | 'y' | 'free';
      moved: boolean;
      patch: Partial<ConnectorElement>;
    };

export default function CanvasSurface(props: Props) {
  const { elements, viewport, onViewportChange, selectedIds, onSelectionChange, editable } = props;
  const surface = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    fromId: string;
    fromSide: Exclude<AnchorSide, 'auto'>;
    cursor: { x: number; y: number };
    startX: number;
    startY: number;
  } | null>(null);
  // Gesture flags live in refs, not state: a quick drag can fire pointerup
  // before React re-binds the listeners, and a stale `moved` would arm the
  // click-to-connect mode instead of completing the drag.
  const connectMoved = useRef(false);
  const connectArmed = useRef(false);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [drawBox, setDrawBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  // Paste has no coordinates, so files land where the pointer last was.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // Where an element being placed would land, drawn as an outline under the pointer.
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  // A double-click whose first press placed something is not also asking for a note.
  const placedAt = useRef(0);

  const byId = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);
  const connectors = useMemo(
    () => elements.filter((el): el is ConnectorElement => el.type === 'connector'),
    [elements],
  );
  const boxes = useMemo(() => elements.filter((el) => el.type !== 'connector'), [elements]);

  // Branches are computed from the tree each render, so they follow their nodes
  // and can never be left dangling.
  const mindEdges = useMemo(() => {
    const nodes = elements.filter((el): el is MindNodeElement => el.type === 'node');
    return nodes
      .filter((node) => node.parentId && byId.has(node.parentId))
      .map((node) => ({
        from: byId.get(node.parentId!)!,
        to: node as CanvasElement,
        color: node.color ?? '#6366f1',
      }));
  }, [elements, byId]);

  useEffect(() => {
    if (props.editRequestId) setEditingId(props.editRequestId);
  }, [props.editRequestId]);

  // --- zoom and pan ---------------------------------------------------------

  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY / 200);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale * factor));
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        onViewportChange({
          scale,
          x: px - ((px - viewport.x) / viewport.scale) * scale,
          y: py - ((py - viewport.y) / viewport.scale) * scale,
        });
      } else {
        onViewportChange({ ...viewport, x: viewport.x - e.deltaX, y: viewport.y - e.deltaY });
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [viewport, onViewportChange]);

  // Pasting an image puts it on the board. Bound to the window because the
  // canvas is not a focusable element, so it never receives paste itself.
  useEffect(() => {
    if (!editable) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal a paste aimed at a text field or an embedded document.
      if (target && (/input|textarea/i.test(target.tagName) || target.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      const rect = surface.current?.getBoundingClientRect();
      const point =
        lastPointer.current ??
        (rect
          ? toCanvasPoint(viewport, rect.left + rect.width / 2, rect.top + rect.height / 2, rect)
          : { x: 0, y: 0 });
      props.onFiles(files, point);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [editable, viewport, props]);

  // Space is the conventional temporary pan modifier on an infinite canvas.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Embedded documents are contenteditable, not inputs. Missing that meant
      // space-to-pan swallowed every space typed into a document card, and
      // Backspace deleted the card instead of a character.
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (/input|textarea|select/i.test(target.tagName) || target.isContentEditable);
      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        setSpaceHeld(true);
      }
      if (typing) return;
      if (e.key === 'Escape') {
        setEditingId(null);
        connectMoved.current = false;
        connectArmed.current = false;
        setPending(null);
        onSelectionChange(new Set());
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && editable && selectedIds.size > 0) {
        e.preventDefault();
        props.onDeleteSelection();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [editable, selectedIds, onSelectionChange, props]);

  // --- gesture handling -----------------------------------------------------
  //
  // Position and size are written straight to the DOM while dragging and
  // committed to the shared document once on release. Writing every pointermove
  // into Yjs re-serialised every element and re-rendered the whole board on each
  // frame, which is what made dragging feel heavy.

  const applyDragStyles = useCallback((dx: number, dy: number, ids: Iterable<string>) => {
    for (const id of ids) {
      const node = nodes.current.get(id);
      if (node) node.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }, []);

  const clearDragStyles = useCallback((ids: Iterable<string>) => {
    for (const id of ids) {
      const node = nodes.current.get(id);
      if (node) node.style.transform = '';
    }
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const g = gesture.current;
      if (!g) return;

      if (g.kind === 'pan') {
        onViewportChange({
          ...viewport,
          x: g.originX + (e.clientX - g.startX),
          y: g.originY + (e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'draw') {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        setDrawBox({
          left: Math.min(g.startX, e.clientX) - rect.left,
          top: Math.min(g.startY, e.clientY) - rect.top,
          width: Math.abs(e.clientX - g.startX),
          height: Math.abs(e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'marquee') {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        setMarquee({
          left: Math.min(g.startX, e.clientX) - rect.left,
          top: Math.min(g.startY, e.clientY) - rect.top,
          width: Math.abs(e.clientX - g.startX),
          height: Math.abs(e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'route') {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        g.moved = true;
        g.patch = applyRoute(g.connector, g.axis, toCanvasPoint(viewport, e.clientX, e.clientY, rect));
        return;
      }

      const dx = (e.clientX - g.startX) / viewport.scale;
      const dy = (e.clientY - g.startY) / viewport.scale;
      // A few pixels of slop keeps a click from registering as a tiny drag.
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      g.moved = true;

      if (g.kind === 'move') {
        applyDragStyles(dx * viewport.scale, dy * viewport.scale, g.origins.keys());
      } else {
        const node = nodes.current.get(g.id);
        if (node) {
          node.style.width = `${Math.max(40, g.origin.width + dx)}px`;
          node.style.height = `${Math.max(40, g.origin.height + dy)}px`;
        }
      }
    }

    function onUp(e: PointerEvent) {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;

      if (g.kind === 'draw') {
        const rect = surface.current?.getBoundingClientRect();
        setDrawBox(null);
        if (rect) {
          const a = toCanvasPoint(viewport, g.startX, g.startY, rect);
          const b = toCanvasPoint(viewport, e.clientX, e.clientY, rect);
          const width = Math.abs(b.x - a.x);
          const height = Math.abs(b.y - a.y);
          // A click rather than a drag still makes a shape, at a usable size.
          if (width < 12 || height < 12) {
            props.onDrawShape({ x: a.x - 110, y: a.y - 80, width: 220, height: 160 });
          } else {
            props.onDrawShape({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height });
          }
        }
        return;
      }

      if (g.kind === 'marquee') {
        const rect = surface.current?.getBoundingClientRect();
        setMarquee(null);
        if (rect) {
          const a = toCanvasPoint(viewport, g.startX, g.startY, rect);
          const b = toCanvasPoint(viewport, e.clientX, e.clientY, rect);
          const x1 = Math.min(a.x, b.x);
          const y1 = Math.min(a.y, b.y);
          const x2 = Math.max(a.x, b.x);
          const y2 = Math.max(a.y, b.y);
          const hits = boxes.filter(
            (el) => el.x < x2 && el.x + el.width > x1 && el.y < y2 && el.y + el.height > y1,
          );
          onSelectionChange(new Set(hits.map((el) => el.id)));
        }
        return;
      }

      if (g.kind === 'route') {
        if (g.moved && Object.keys(g.patch).length) {
          props.onCommit([{ id: g.connector.id, patch: g.patch as Partial<CanvasElement> }]);
        }
        return;
      }

      if (g.kind === 'move' && g.moved) {
        const dx = (e.clientX - g.startX) / viewport.scale;
        const dy = (e.clientY - g.startY) / viewport.scale;
        clearDragStyles(g.origins.keys());
        props.onCommit(
          [...g.origins].map(([id, origin]) => ({
            id,
            patch: { x: origin.x + dx, y: origin.y + dy } as Partial<CanvasElement>,
          })),
        );
      } else if (g.kind === 'resize' && g.moved) {
        const dx = (e.clientX - g.startX) / viewport.scale;
        const dy = (e.clientY - g.startY) / viewport.scale;
        const node = nodes.current.get(g.id);
        if (node) {
          node.style.width = '';
          node.style.height = '';
        }
        props.onCommit([
          {
            id: g.id,
            patch: {
              width: Math.max(40, g.origin.width + dx),
              height: Math.max(40, g.origin.height + dy),
            } as Partial<CanvasElement>,
          },
        ]);
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [viewport, boxes, onViewportChange, onSelectionChange, applyDragStyles, clearDragStyles, props]);

  // Making a connection works two ways: drag from a port and release on the
  // target, or click the port, move, and click the target. Both share this
  // handler; a release that never moved arms the second mode instead of ending.
  useEffect(() => {
    if (!pending) return;

    /** Resolves the element and, when precise, the exact face under a point. */
    const targetAt = (x: number, y: number) => {
      const node = document.elementFromPoint(x, y);
      const port = node?.closest<HTMLElement>('[data-port-side]');
      const host = node?.closest<HTMLElement>('[data-canvas-element]');
      return { id: host?.dataset.canvasElement, side: (port?.dataset.portSide as AnchorSide) ?? 'auto' };
    };

    const cancel = () => {
      connectMoved.current = false;
      connectArmed.current = false;
      setPending(null);
      setHoverId(null);
    };

    const complete = (x: number, y: number) => {
      const { id, side } = targetAt(x, y);
      if (id && id !== pending.fromId) {
        props.onConnect({ id: pending.fromId, side: pending.fromSide }, { id, side });
      }
      cancel();
    };

    const onMove = (e: PointerEvent) => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      if (Math.abs(e.clientX - pending.startX) + Math.abs(e.clientY - pending.startY) > 3) {
        connectMoved.current = true;
      }
      setPending((current) =>
        current ? { ...current, cursor: toCanvasPoint(viewport, e.clientX, e.clientY, rect) } : current,
      );
      setHoverId(targetAt(e.clientX, e.clientY).id ?? null);
    };

    const onUp = (e: PointerEvent) => {
      if (connectArmed.current) return; // armed mode ends on the next press
      if (!connectMoved.current) {
        // A click rather than a drag: keep the line attached to the cursor.
        connectArmed.current = true;
        return;
      }
      complete(e.clientX, e.clientY);
    };

    // Capture phase so completing a click-to-connect runs before the element's
    // own handler, which would otherwise start a fresh connection from it.
    const onDown = (e: PointerEvent) => {
      if (!connectArmed.current) return;
      const { id } = targetAt(e.clientX, e.clientY);
      if (id && id !== pending.fromId) {
        e.stopPropagation();
        e.preventDefault();
        complete(e.clientX, e.clientY);
        return;
      }
      // Clicking anywhere else abandons the connection.
      cancel();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerdown', onDown, { capture: true });
    };
  }, [pending, viewport, props]);

  const previewPath = (() => {
    if (!pending) return null;
    const from = byId.get(pending.fromId);
    if (!from) return null;
    const p1 = sidePoint(from, pending.fromSide);
    return { path: connectorPath(p1, pending.fromSide, pending.cursor, 'left', 'straight') };
  })();

  /** Drags out of an anchor port until released over another element or port. */
  function startPortDrag(e: React.PointerEvent, elementId: string, side: Exclude<AnchorSide, 'auto'>) {
    e.stopPropagation();
    e.preventDefault();
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    connectMoved.current = false;
    connectArmed.current = false;
    setPending({
      fromId: elementId,
      fromSide: side,
      cursor: toCanvasPoint(viewport, e.clientX, e.clientY, rect),
      startX: e.clientX,
      startY: e.clientY,
    });
  }

  /**
   * Computes the routing patch for a pointer position and paints it straight
   * into the SVG, so reshaping stays smooth and lands as one committed change.
   */
  function applyRoute(connector: ConnectorElement, axis: 'x' | 'y' | 'free', point: { x: number; y: number }) {
    const from = byId.get(connector.from);
    const to = byId.get(connector.to);
    if (!from || !to) return {};

    const shape = connector.shape ?? 'straight';
    const patch: Partial<ConnectorElement> =
      axis === 'x'
        ? { midX: point.x }
        : axis === 'y'
          ? { midY: point.y }
          : // Bending a straight line is how you turn it into a curve.
            { bend: point, ...(shape === 'straight' ? { shape: 'curved' as const } : null) };

    const { s1, s2, p1, p2 } = resolveEndpoints(
      from,
      to,
      connector.fromSide ?? 'auto',
      connector.toSide ?? 'auto',
    );
    const nextShape = patch.shape ?? shape;
    const route = {
      midX: patch.midX ?? connector.midX,
      midY: patch.midY ?? connector.midY,
      bend: patch.bend ?? connector.bend,
    };
    const d = connectorPath(p1, s1, p2, s2, nextShape, route);

    const root = surface.current;
    root?.querySelector(`[data-connector-line="${connector.id}"]`)?.setAttribute('d', d);
    root?.querySelector(`[data-connector-hit="${connector.id}"]`)?.setAttribute('d', d);
    const handlePoint = routeHandle(p1, s1, p2, s2, nextShape, route)?.point;
    const knob = root?.querySelector(`[data-connector-handle="${connector.id}"]`);
    if (knob && handlePoint) {
      knob.setAttribute('cx', String(handlePoint.x));
      knob.setAttribute('cy', String(handlePoint.y));
    }
    return patch;
  }

  function startRouteGesture(
    e: React.PointerEvent,
    connector: ConnectorElement,
    axis: 'x' | 'y' | 'free',
  ) {
    e.stopPropagation();
    e.preventDefault();
    gesture.current = { kind: 'route', connector, axis, moved: false, patch: {} };
  }

  function startElementGesture(e: React.PointerEvent, element: CanvasElement) {
    if (spaceHeld) return; // space always pans, whatever is under the cursor
    // Let the press through to the board so a shape can be drawn over anything.
    if (props.shapeTool && props.editable) return;
    // Likewise an element being placed can go on top of another.
    if (props.placing && props.editable) return;
    // With the connector tool on, pressing an element's body starts a
    // connection from its facing side rather than moving it.
    if (props.connectorTool && props.editable) {
      const centre = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
      const rect = surface.current?.getBoundingClientRect();
      if (rect) {
        const cursor = toCanvasPoint(viewport, e.clientX, e.clientY, rect);
        const side = ANCHOR_SIDES.reduce((best, candidate) => {
          const a = sidePoint(element, candidate);
          const b = sidePoint(element, best);
          return Math.hypot(a.x - cursor.x, a.y - cursor.y) < Math.hypot(b.x - cursor.x, b.y - cursor.y)
            ? candidate
            : best;
        }, ANCHOR_SIDES[0]);
        void centre;
        startPortDrag(e, element.id, side);
      }
      return;
    }
    e.stopPropagation();

    // Editing a text element must not start a drag from inside the textarea.
    if (editingId === element.id) return;

    const additive = e.shiftKey;
    const nextSelection = additive
      ? new Set(selectedIds).add(element.id)
      : selectedIds.has(element.id)
        ? selectedIds
        : new Set([element.id]);
    if (nextSelection !== selectedIds) onSelectionChange(nextSelection);
    if (editingId) setEditingId(null);
    if (!editable) return;

    props.onBringToFront(element.id);
    const origins = new Map<string, { x: number; y: number }>();
    for (const id of nextSelection) {
      const el = byId.get(id);
      if (el && el.type !== 'connector') origins.set(id, { x: el.x, y: el.y });
    }
    gesture.current = { kind: 'move', startX: e.clientX, startY: e.clientY, origins, moved: false };
  }

  function startBackgroundGesture(e: React.PointerEvent) {
    setEditingId(null);
    // Panning with the middle button, Alt or Space still works while placing.
    if (props.placing && editable && e.button === 0 && !spaceHeld && !e.altKey) {
      const rect = surface.current?.getBoundingClientRect();
      if (rect) {
        placedAt.current = Date.now();
        setGhost(null);
        props.onPlace(toCanvasPoint(viewport, e.clientX, e.clientY, rect));
      }
      return;
    }
    if (props.shapeTool && editable && e.button === 0 && !spaceHeld && !e.altKey) {
      gesture.current = { kind: 'draw', startX: e.clientX, startY: e.clientY };
      return;
    }
    if (e.button === 1 || e.altKey || spaceHeld) {
      gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y };
      return;
    }
    if (e.shiftKey) {
      gesture.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY };
      return;
    }
    onSelectionChange(new Set());
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y };
  }

  return (
    <div
      ref={surface}
      onPointerMove={(e) => {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        lastPointer.current = toCanvasPoint(viewport, e.clientX, e.clientY, rect);
        if (props.placing) setGhost(lastPointer.current);
        props.onPointer?.(lastPointer.current);
      }}
      onPointerLeave={() => {
        setGhost(null);
        props.onPointer?.(null);
      }}
      onDragOver={(e) => {
        if (!editable || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropActive(false);
      }}
      onDrop={(e) => {
        if (!editable) return;
        const files = [...e.dataTransfer.files];
        setDropActive(false);
        if (files.length === 0) return;
        e.preventDefault();
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        props.onFiles(files, toCanvasPoint(viewport, e.clientX, e.clientY, rect));
      }}
      onPointerDown={startBackgroundGesture}
      onDoubleClick={(e) => {
        if (!editable) return;
        const rect = surface.current?.getBoundingClientRect();
        if (!rect || e.target !== surface.current) return;
        if (props.placing || Date.now() - placedAt.current < 500) return;
        // Double-clicking empty space drops a note there, as on other boards.
        props.onCreateNoteAt(toCanvasPoint(viewport, e.clientX, e.clientY, rect));
      }}
      className={cx(
        'relative h-full w-full touch-none overflow-hidden bg-[var(--color-canvas)]',
        props.connectorTool || props.shapeTool || (props.placing && editable)
          ? 'cursor-crosshair'
          : spaceHeld
            ? 'cursor-grab'
            : 'cursor-default',
      )}
      style={{
        backgroundImage: 'radial-gradient(var(--color-line) 1px, transparent 1px)',
        backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
    >
      {/* Pinned to a zero-size box so its origin is exactly the surface origin.
          Children are absolutely positioned and overflow it, but without this
          the oversized connector SVG stretches the box and every screen/canvas
          conversion measured from it — zoom to fit included — is offset. */}
      <div
        className="absolute left-0 top-0 h-0 w-0 origin-top-left"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
      >
{/* Connectors paint above the elements: a line routed across a shape, and
            especially its arrowhead at the shape's edge, must stay visible. The
            layer is pointer-transparent apart from the lines and handles. */}
        {boxes.map((element) => {
          const selected = selectedIds.has(element.id);
          const editing = editingId === element.id;
          return (
            <div
              key={element.id}
              ref={(node) => {
                if (node) nodes.current.set(element.id, node);
                else nodes.current.delete(element.id);
              }}
              data-canvas-element={element.id}
              onPointerEnter={() => props.connectorTool && setHoverId(element.id)}
              onPointerLeave={() => !pending && setHoverId((id) => (id === element.id ? null : id))}
              onPointerDown={(e) => startElementGesture(e, element)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!editable) return;
                // Document cards edit in place; the header's expand button opens full page.
                if (
                  element.type === 'note' ||
                  element.type === 'text' ||
                  element.type === 'shape' ||
                  element.type === 'node' ||
                  element.type === 'frame' ||
                  element.type === 'link' ||
                  element.type === 'workItem'
                ) {
                  setEditingId(element.id);
                }
              }}
              className={cx(
                'absolute',
                selected && 'outline outline-2 outline-offset-2 outline-[var(--color-accent)]',
                pending &&
                  hoverId === element.id &&
                  element.id !== pending.fromId &&
                  'outline outline-2 outline-[var(--color-accent)]',
                !editing && (props.connectorTool ? 'cursor-crosshair' : 'cursor-move'),
              )}
              style={{ left: element.x, top: element.y, width: element.width, height: element.height, borderRadius: 8 }}
            >
              {element.type === 'frame' && (
                <span className="absolute -top-6 left-0 select-none text-xs font-medium text-[var(--color-muted)]">
                  {(element as FrameElement).name || 'Frame'}
                </span>
              )}

              {/* Interiors stay inert unless this element is being edited, so a
                  click always reaches the wrapper and starts a drag. */}
              <div
                className={cx(
                  'h-full w-full',
                  !editing && (element.type === 'link' ? '[&_*]:pointer-events-none' : 'pointer-events-none'),
                )}
              >
                <CanvasElementView
                  element={element}
                  selected={selected}
                  editing={editing}
                  dark={props.dark}
                  members={props.members}
                  onChange={(patch) => props.onUpdate(element.id, patch)}
                  onStopEditing={() => setEditingId(null)}
                  onOpenDocument={props.onOpenDocument}
                />
              </div>

              {props.connectorTool && editable && (hoverId === element.id || pending?.fromId === element.id) &&
                ANCHOR_SIDES.map((side) => {
                  const point = sidePoint(element, side);
                  const size = 10 / viewport.scale;
                  return (
                    <div
                      key={side}
                      data-port-side={side}
                      onPointerDown={(e) => startPortDrag(e, element.id, side)}
                      title={`Connect from ${side}`}
                      className="pointer-events-auto absolute rounded-full border-2 border-white bg-[var(--color-accent)]"
                      style={{
                        left: point.x - element.x - size / 2,
                        top: point.y - element.y - size / 2,
                        width: size,
                        height: size,
                      }}
                    />
                  );
                })}

              {element.type === 'node' && editable && (selected || hoverId === element.id) && !editing && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onAddChild(element.id);
                  }}
                  aria-label="Add a child node"
                  className="absolute grid place-items-center rounded-full border-2 border-white bg-[var(--color-accent)] font-semibold text-white shadow"
                  style={{
                    // Sized in screen pixels so it stays usable at any zoom.
                    width: 22 / viewport.scale,
                    height: 22 / viewport.scale,
                    fontSize: 15 / viewport.scale,
                    right: -30 / viewport.scale,
                    top: `calc(50% - ${11 / viewport.scale}px)`,
                  }}
                >
                  <Icon name="plus-lg" />
                </button>
              )}

              {selected && editable && !editing && !props.connectorTool && (
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    gesture.current = {
                      kind: 'resize',
                      id: element.id,
                      startX: e.clientX,
                      startY: e.clientY,
                      origin: { width: element.width, height: element.height },
                      moved: false,
                    };
                  }}
                  className="absolute -bottom-1 -right-1 cursor-nwse-resize rounded-sm border border-white bg-[var(--color-accent)]"
                  style={{ width: 10 / viewport.scale, height: 10 / viewport.scale }}
                />
              )}
            </div>
          );
        })}

        <Connectors
          connectors={connectors}
          byId={byId}
          selectedIds={selectedIds}
          preview={previewPath}
          mindEdges={mindEdges}
          scale={viewport.scale}
          editable={editable}
          onRouteHandleDown={startRouteGesture}
          onSelect={(id, additive) =>
            onSelectionChange(additive ? new Set(selectedIds).add(id) : new Set([id]))
          }
        />

        {props.placing && editable && ghost && (
          <div
            className="pointer-events-none absolute rounded-lg border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            style={{
              left: ghost.x - props.placing.width / 2,
              top: ghost.y - props.placing.height / 2,
              width: props.placing.width,
              height: props.placing.height,
            }}
          />
        )}
      </div>

      {drawBox && (
        <div
          className="pointer-events-none absolute rounded border-2 border-[var(--color-accent)] bg-[var(--color-accent)]/10"
          style={drawBox}
        />
      )}

      {dropActive && (
        <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/5" />
      )}

      {marquee && (
        <div
          className="pointer-events-none absolute border border-[var(--color-accent)] bg-[var(--color-accent)]/10"
          style={marquee}
        />
      )}
    </div>
  );
}
