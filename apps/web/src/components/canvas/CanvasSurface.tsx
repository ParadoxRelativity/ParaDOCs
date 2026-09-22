import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ANCHOR_SIDES,
  canvasSearchText,
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
import { useMemberNames } from './MentionText';
import { groupIndex, snapMove, snapResize, unionRect, withGroups, type Guide, type Rect } from '../../lib/canvasArrange';

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/** An element on its way — an upload, a document being made — drawn until the real one lands. */
export interface PendingBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
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
  /** `keep` is true when Shift was held, asking for the tool to stay on for another. */
  onDrawShape: (rect: { x: number; y: number; width: number; height: number }, keep: boolean) => void;
  /**
   * The size of an element waiting to be placed. While set, an outline of it
   * follows the pointer and the next click on the board places it there.
   */
  placing: { width: number; height: number } | null;
  onPlace: (point: { x: number; y: number }, keep: boolean) => void;
  onConnect: (
    from: { id: string; side: AnchorSide },
    to: { id: string; side: AnchorSide },
  ) => void;
  onUpdate: (id: string, patch: Partial<CanvasElement>) => void;
  /** Called once per gesture, so a drag is a single undoable change. */
  onCommit: (updates: { id: string; patch: Partial<CanvasElement> }[]) => void;
  /** Called after elements have been dragged, which lifts them above what they were dropped on. */
  onBringToFront: (ids: string[]) => void;
  onOpenDocument: (documentId: string) => void;
  dark: boolean;
  onDeleteSelection: () => void;
  onCreateNoteAt: (point: { x: number; y: number }) => void;
  /** Adds a child under a mind-map node; works at any depth. */
  onAddChild: (parentId: string) => void;
  /** Adds a node beside a mind-map node, under the same parent. */
  onAddSibling: (nodeId: string) => void;
  /**
   * Set by the editor to open an element for typing. The sequence number lets
   * the same element be asked for twice in a row.
   */
  editRequest: { id: string; seq: number } | null;
  /** Files pasted or dropped onto the board, with the drop point in canvas units. */
  onFiles: (files: File[], point: { x: number; y: number }) => void;
  /** Anything else pasted onto the board. Returns true when it was used. */
  onPasteData: (data: DataTransfer, point: { x: number; y: number }) => boolean;
  /** The pointer's position in canvas units as it moves, and null when it leaves the board. */
  onPointer?: (point: { x: number; y: number } | null) => void;
  /** Placeholders for elements still being made. */
  pendingBoxes: PendingBox[];
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;

/** Elements whose own controls take clicks once selected: players and framed pages. */
const LIVE_WHEN_SELECTED = new Set<CanvasElement['type']>(['video', 'audio', 'embed']);

/** Elements with something to type into. */
const EDITABLE = new Set<CanvasElement['type']>(['note', 'text', 'shape', 'node', 'frame', 'link', 'workItem']);

/** How close, in screen pixels, an edge must come to another before it snaps to it. */
const SNAP_DISTANCE = 6;

/** Pictures keep their proportions when resized unless Shift is held; everything else, only while it is. */
const KEEP_RATIO = new Set<CanvasElement['type']>(['image', 'video']);

const TYPE_LABELS: Record<CanvasElement['type'], string> = {
  note: 'Sticky note',
  text: 'Text',
  link: 'Document',
  embed: 'Embedded page',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  shape: 'Shape',
  node: 'Mind map node',
  frame: 'Frame',
  connector: 'Connector',
  sheetCell: 'Spreadsheet cell',
  sheetChart: 'Spreadsheet chart',
  workItem: 'Work item',
};

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

export function toCanvasPoint(viewport: Viewport, clientX: number, clientY: number, rect: DOMRect) {
  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale,
  };
}

/** The viewport that shows the same canvas point under `screen` at a new scale. */
export function zoomAround(viewport: Viewport, scale: number, screen: { x: number; y: number }): Viewport {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  return {
    scale: next,
    x: screen.x - ((screen.x - viewport.x) / viewport.scale) * next,
    y: screen.y - ((screen.y - viewport.y) / viewport.scale) * next,
  };
}

/** A box resized by dragging one corner, the opposite corner staying put. */
function resizeBox(
  origin: { x: number; y: number; width: number; height: number },
  corner: Corner,
  dx: number,
  dy: number,
  keepRatio: boolean,
) {
  const min = 40;
  let width = origin.width + (corner.includes('e') ? dx : -dx);
  let height = origin.height + (corner.includes('s') ? dy : -dy);
  if (keepRatio && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height;
    if (width / origin.width > height / origin.height) height = width / ratio;
    else width = height * ratio;
    if (width < min || height < min) {
      const grow = Math.max(min / width, min / height);
      width *= grow;
      height *= grow;
    }
  } else {
    width = Math.max(min, width);
    height = Math.max(min, height);
  }
  return {
    x: corner.includes('w') ? origin.x + origin.width - width : origin.x,
    y: corner.includes('n') ? origin.y + origin.height - height : origin.y,
    width,
    height,
  };
}

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | {
      kind: 'pinch';
      startDistance: number;
      startMid: { x: number; y: number };
      origin: Viewport;
    }
  | {
      kind: 'move';
      startX: number;
      startY: number;
      origins: Map<string, { x: number; y: number }>;
      moved: boolean;
      /** The element pressed, and whether it was already selected: a click on it, not a drag, narrows the selection. */
      pressed: string;
      wasSelected: boolean;
      /** What is being dragged, as one box, and what it can line up with. */
      bounds: Rect;
      others: Rect[];
      /** The offset so far, snapping included, which is what the release commits. */
      dx: number;
      dy: number;
    }
  | {
      kind: 'resize';
      id: string;
      corner: Corner;
      startX: number;
      startY: number;
      origin: { x: number; y: number; width: number; height: number };
      keepRatio: boolean;
      moved: boolean;
      last: { x: number; y: number; width: number; height: number };
      others: Rect[];
    }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
  | { kind: 'draw'; startX: number; startY: number }
  | {
      kind: 'route';
      connector: ConnectorElement;
      axis: 'x' | 'y' | 'free';
      moved: boolean;
      patch: Partial<ConnectorElement>;
    };

export default function CanvasSurface(props: Props) {
  const { elements, viewport, selectedIds, onSelectionChange, editable } = props;
  const surface = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);
  // Window listeners are bound once and read what they need from here, rather
  // than being torn down and re-bound on every render and every frame of a pan.
  const latest = useRef(props);
  latest.current = props;

  // The viewport as it is right now. A pan or a pinch moves it many times a
  // frame; the editor is told at most once a frame, and until it re-renders
  // this is the truth every screen-to-canvas conversion must use.
  const live = useRef(viewport);
  const frame = useRef(0);
  useLayoutEffect(() => {
    if (!frame.current) live.current = viewport;
  }, [viewport]);
  const setViewport = useCallback((next: Viewport) => {
    live.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      latest.current.onViewportChange(live.current);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The element under a press that is still held. Selected media stays inert
  // until the press ends: going live mid-press handed the rest of the gesture
  // to the video or iframe, which swallowed the release (or began a native
  // drag), so the element went on following the cursor after the button was up.
  const [pressedId, setPressedId] = useState<string | null>(null);
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
  // Fingers on the board, so a second one turns the gesture into a pinch.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  // When a key was last pressed, so finishing an edit from the keyboard puts
  // focus back on the element instead of dropping it on the page.
  const lastKeyAt = useRef(0);
  // The node Tab last arrived on. Tab on a selected node adds a child, but not
  // on one the keyboard is only passing through, or Tab could never leave it.
  const tabbedTo = useRef<string | null>(null);
  const refocusing = useRef(false);

  const byId = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const connectors = useMemo(
    () => elements.filter((el): el is ConnectorElement => el.type === 'connector'),
    [elements],
  );
  const boxes = useMemo(() => elements.filter((el) => el.type !== 'connector'), [elements]);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const groups = useMemo(() => groupIndex(elements), [elements]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // Alignment guides shown while dragging. Set only when they change, so a
  // drag that is not lining anything up does not re-render the board.
  const [guides, setGuides] = useState<Guide[]>([]);
  const guidesKey = useRef('');
  const showGuides = useCallback((next: Guide[]) => {
    const key = JSON.stringify(next);
    if (key === guidesKey.current) return;
    guidesKey.current = key;
    setGuides(next);
  }, []);

  /** Groups every member of which is selected, outlined so the group reads as one thing. */
  const selectedGroups = useMemo(() => {
    const seen = new Set<string[]>();
    for (const id of selectedIds) {
      const members = groups.get(id);
      if (members && members.every((m) => selectedIds.has(m))) seen.add(members);
    }
    return [...seen].map((members) => unionRect(members.map((id) => byId.get(id)!).filter(Boolean)));
  }, [selectedIds, groups, byId]);
  const editingRef = useRef(editingId);
  editingRef.current = editingId;

  const names = useMemberNames(props.members);
  const labelOf = useCallback(
    (element: CanvasElement) => {
      const text = canvasSearchText([element], names).replace(/\s+/g, ' ').replace(/^(#+|-) /, '').trim();
      return text ? `${TYPE_LABELS[element.type]}: ${text.slice(0, 80)}` : TYPE_LABELS[element.type];
    },
    [names],
  );

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
    if (props.editRequest) setEditingId(props.editRequest.id);
  }, [props.editRequest]);

  /** Ends editing; from the keyboard, focus goes back to the element so the next key still acts on it. */
  const stopEditing = useCallback((id: string) => {
    setEditingId((current) => (current === id ? null : current));
    if (Date.now() - lastKeyAt.current < 200) {
      // After React has removed the text box, which is what drops focus.
      setTimeout(() => {
        if (document.activeElement !== document.body) return;
        refocusing.current = true;
        nodes.current.get(id)?.focus({ preventScroll: true });
        refocusing.current = false;
      });
    }
  }, []);

  // Stable for the memoised views: the latest handlers are read at call time.
  const onUpdate = useCallback(
    (id: string, patch: Partial<CanvasElement>) => latest.current.onUpdate(id, patch),
    [],
  );
  const onOpenDocument = useCallback((documentId: string) => latest.current.onOpenDocument(documentId), []);
  const onSelectConnector = useCallback((id: string, additive: boolean) => {
    const current = latest.current.selectedIds;
    latest.current.onSelectionChange(additive ? new Set(current).add(id) : new Set([id]));
  }, []);

  // --- zoom and pan ---------------------------------------------------------

  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const view = live.current;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinches arrive as ctrl+wheel too.
        const factor = Math.exp(-e.deltaY / 200);
        setViewport(zoomAround(view, view.scale * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top }));
      } else {
        // A mouse wheel only scrolls one way; with Shift it scrolls across.
        const horizontal = e.shiftKey && e.deltaX === 0;
        const dx = horizontal ? e.deltaY : e.deltaX;
        const dy = horizontal ? 0 : e.deltaY;
        setViewport({ ...view, x: view.x - dx, y: view.y - dy });
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [setViewport]);

  // Pasting puts files, or copied elements, on the board. Bound to the window
  // because the board is rarely what has focus when a paste arrives.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const p = latest.current;
      if (!p.editable || !e.clipboardData) return;
      const target = e.target as HTMLElement | null;
      // Never steal a paste aimed at a text field or an embedded document.
      if (target && (/input|textarea/i.test(target.tagName) || target.isContentEditable)) return;
      // Nor one aimed at a dialog over the board.
      if (target?.closest('[role="dialog"]')) return;
      const rect = surface.current?.getBoundingClientRect();
      const point =
        lastPointer.current ??
        (rect
          ? toCanvasPoint(live.current, rect.left + rect.width / 2, rect.top + rect.height / 2, rect)
          : { x: 0, y: 0 });
      const files = [...e.clipboardData.files];
      if (files.length > 0) {
        e.preventDefault();
        p.onFiles(files, point);
        return;
      }
      if (p.onPasteData(e.clipboardData, point)) e.preventDefault();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Keys that act on the board itself: Space to pan, Escape, Delete, and the
  // ones that start typing into or growing the selected element.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      lastKeyAt.current = Date.now();
      const p = latest.current;
      // Embedded documents are contenteditable, not inputs. Missing that meant
      // space-to-pan swallowed every space typed into a document card, and
      // Backspace deleted the card instead of a character.
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (/input|textarea|select/i.test(target.tagName) || target.isContentEditable);
      if (typing || target?.closest('[role="dialog"], [role="menu"]')) return;
      // Keys pressed on a toolbar button belong to that button.
      if (target?.closest('button') && (e.key === 'Enter' || e.code === 'Space')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        spaceRef.current = true;
        setSpaceHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        setEditingId(null);
        connectMoved.current = false;
        connectArmed.current = false;
        setPending(null);
        p.onSelectionChange(new Set());
        return;
      }
      if (!p.editable || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && p.selectedIds.size > 0) {
        e.preventDefault();
        p.onDeleteSelection();
        return;
      }
      if (e.key !== 'Tab' && e.key !== 'Shift') tabbedTo.current = null;
      if (p.selectedIds.size !== 1) return;
      const element = byIdRef.current.get([...p.selectedIds][0]);
      if (!element) return;
      // Mind maps grow from the keyboard: Tab for a child, Enter for a sibling.
      if (element.type === 'node' && e.key === 'Tab' && !e.shiftKey) {
        if (tabbedTo.current === element.id) return;
        e.preventDefault();
        p.onAddChild(element.id);
        return;
      }
      if (element.type === 'node' && e.key === 'Enter' && element.parentId) {
        e.preventDefault();
        p.onAddSibling(element.id);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'F2') && EDITABLE.has(element.type)) {
        e.preventDefault();
        setEditingId(element.id);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    // Letting go of Space in another window must not leave the board panning.
    const blur = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // --- gesture handling -----------------------------------------------------
  //
  // Position and size are written straight to the DOM while dragging and
  // committed to the shared document once on release. Writing every pointermove
  // into Yjs re-serialised every element and re-rendered the whole board on each
  // frame, which is what made dragging feel heavy.

  const clearDragStyles = useCallback((ids: Iterable<string>) => {
    for (const id of ids) {
      const node = nodes.current.get(id);
      if (node) node.style.transform = '';
    }
  }, []);

  /** Drops whatever gesture is under way and puts the board back as it was. */
  const abandonGesture = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    setPressedId(null);
    if (!g) return;
    setDrawBox(null);
    setMarquee(null);
    showGuides([]);
    if (g.kind === 'move') clearDragStyles(g.origins.keys());
    if (g.kind === 'resize') {
      const node = nodes.current.get(g.id);
      if (node) {
        node.style.left = `${g.origin.x}px`;
        node.style.top = `${g.origin.y}px`;
        node.style.width = `${g.origin.width}px`;
        node.style.height = `${g.origin.height}px`;
      }
    }
  }, [clearDragStyles]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
        touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      const g = gesture.current;
      if (!g) return;
      // A mouse moving with no button down means the release was missed
      // (it happened over an iframe, or outside the window), so end it here.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        onUp(e);
        return;
      }
      const view = live.current;
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;

      if (g.kind === 'pinch') {
        const [a, b] = [...touches.current.values()];
        if (!a || !b) return;
        const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const scale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, g.origin.scale * (distance / Math.max(1, g.startDistance))),
        );
        // Keep the canvas point that was under the fingers' midpoint under it
        // as they move apart and travel.
        const anchor = {
          x: (g.startMid.x - g.origin.x) / g.origin.scale,
          y: (g.startMid.y - g.origin.y) / g.origin.scale,
        };
        setViewport({ scale, x: mid.x - anchor.x * scale, y: mid.y - anchor.y * scale });
        return;
      }

      if (g.kind === 'pan') {
        setViewport({
          ...view,
          x: g.originX + (e.clientX - g.startX),
          y: g.originY + (e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'draw') {
        setDrawBox({
          left: Math.min(g.startX, e.clientX) - rect.left,
          top: Math.min(g.startY, e.clientY) - rect.top,
          width: Math.abs(e.clientX - g.startX),
          height: Math.abs(e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'marquee') {
        setMarquee({
          left: Math.min(g.startX, e.clientX) - rect.left,
          top: Math.min(g.startY, e.clientY) - rect.top,
          width: Math.abs(e.clientX - g.startX),
          height: Math.abs(e.clientY - g.startY),
        });
        return;
      }

      if (g.kind === 'route') {
        g.moved = true;
        g.patch = applyRoute(g.connector, g.axis, toCanvasPoint(view, e.clientX, e.clientY, rect));
        return;
      }

      const dx = (e.clientX - g.startX) / view.scale;
      const dy = (e.clientY - g.startY) / view.scale;
      // A few pixels of slop keeps a click from registering as a tiny drag.
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      g.moved = true;

      // Holding ⌘ or Ctrl places freely, without snapping.
      const snapping = !(e.metaKey || e.ctrlKey);
      const threshold = SNAP_DISTANCE / view.scale;

      if (g.kind === 'move') {
        let next = { dx, dy, guides: [] as Guide[] };
        if (snapping) {
          const snap = snapMove({ ...g.bounds, x: g.bounds.x + dx, y: g.bounds.y + dy }, g.others, threshold);
          next = { dx: dx + snap.dx, dy: dy + snap.dy, guides: snap.guides };
        }
        g.dx = next.dx;
        g.dy = next.dy;
        showGuides(next.guides);
        for (const id of g.origins.keys()) {
          const node = nodes.current.get(id);
          if (node) node.style.transform = `translate(${g.dx}px, ${g.dy}px)`;
        }
      } else {
        const keepRatio = g.keepRatio !== e.shiftKey;
        g.last = resizeBox(g.origin, g.corner, dx, dy, keepRatio);
        // A box keeping its proportions cannot also have an edge pulled to a line.
        if (snapping && !keepRatio) {
          const snap = snapResize(g.last, g.corner, g.others, threshold);
          g.last = snap.box;
          showGuides(snap.guides);
        } else {
          showGuides([]);
        }
        const node = nodes.current.get(g.id);
        if (node) {
          node.style.left = `${g.last.x}px`;
          node.style.top = `${g.last.y}px`;
          node.style.width = `${g.last.width}px`;
          node.style.height = `${g.last.height}px`;
        }
      }
    }

    function onUp(e: PointerEvent) {
      touches.current.delete(e.pointerId);
      const g = gesture.current;
      const p = latest.current;
      if (g?.kind === 'pinch') {
        // Lifting one finger ends the pinch; the other does not start a pan.
        if (touches.current.size < 2) gesture.current = null;
        return;
      }
      gesture.current = null;
      setPressedId(null);
      if (!g) return;
      const view = live.current;
      const rect = surface.current?.getBoundingClientRect();

      if (g.kind === 'draw') {
        setDrawBox(null);
        if (rect) {
          const a = toCanvasPoint(view, g.startX, g.startY, rect);
          const b = toCanvasPoint(view, e.clientX, e.clientY, rect);
          const width = Math.abs(b.x - a.x);
          const height = Math.abs(b.y - a.y);
          // A click rather than a drag still makes a shape, at a usable size.
          if (width < 12 || height < 12) {
            p.onDrawShape({ x: a.x - 110, y: a.y - 80, width: 220, height: 160 }, e.shiftKey);
          } else {
            p.onDrawShape({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height }, e.shiftKey);
          }
        }
        return;
      }

      if (g.kind === 'marquee') {
        setMarquee(null);
        if (!rect) return;
        const a = toCanvasPoint(view, g.startX, g.startY, rect);
        const b = toCanvasPoint(view, e.clientX, e.clientY, rect);
        // A click on empty board, not a drag: that only clears the selection.
        if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) < 4) return;
        const x1 = Math.min(a.x, b.x);
        const y1 = Math.min(a.y, b.y);
        const x2 = Math.max(a.x, b.x);
        const y2 = Math.max(a.y, b.y);
        const hits = boxesRef.current.filter(
          (el) => el.x < x2 && el.x + el.width > x1 && el.y < y2 && el.y + el.height > y1,
        );
        const next = new Set(g.additive ? p.selectedIds : []);
        // Touching any member of a group takes the whole group.
        for (const id of withGroups(hits.map((el) => el.id), groupsRef.current)) next.add(id);
        p.onSelectionChange(next);
        return;
      }

      if (g.kind === 'route') {
        if (g.moved && Object.keys(g.patch).length) {
          p.onCommit([{ id: g.connector.id, patch: g.patch as Partial<CanvasElement> }]);
        }
        return;
      }

      showGuides([]);
      if (g.kind === 'move' && !g.moved && g.wasSelected) {
        // A click on something already selected, not a drag. Clicking a
        // selected group picks out the one member; clicking one of several
        // selected things keeps just that one (or its group).
        const group = withGroups([g.pressed], groupsRef.current);
        const selection = p.selectedIds;
        const isGroup = group.size > 1 && selection.size === group.size && [...group].every((id) => selection.has(id));
        if (isGroup) p.onSelectionChange(new Set([g.pressed]));
        else if (selection.size > group.size) p.onSelectionChange(group);
        return;
      }
      if (g.kind === 'move' && g.moved) {
        clearDragStyles(g.origins.keys());
        p.onCommit(
          [...g.origins].map(([id, origin]) => ({
            id,
            patch: { x: origin.x + g.dx, y: origin.y + g.dy } as Partial<CanvasElement>,
          })),
        );
        p.onBringToFront([...g.origins.keys()]);
      } else if (g.kind === 'resize' && g.moved) {
        // The node already shows the final box; the commit makes it true.
        p.onCommit([{ id: g.id, patch: g.last as Partial<CanvasElement> }]);
      }
    }

    // The browser took the pointer (a native drag, a touch scroll): drop the
    // gesture and put everything back rather than committing a guessed position.
    function onCancel(e: PointerEvent) {
      touches.current.delete(e.pointerId);
      if (gesture.current?.kind === 'pinch' && touches.current.size >= 2) return;
      abandonGesture();
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, []);

  /**
   * A second finger on the board turns whatever the first one started into a
   * pinch, so zooming works wherever the fingers land, elements included.
   */
  function trackTouch(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size !== 2) return;
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    abandonGesture();
    connectMoved.current = false;
    connectArmed.current = false;
    setPending(null);
    const [a, b] = [...touches.current.values()];
    gesture.current = {
      kind: 'pinch',
      startDistance: Math.hypot(a.x - b.x, a.y - b.y),
      startMid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      origin: live.current,
    };
    e.stopPropagation();
  }

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
        latest.current.onConnect({ id: pending.fromId, side: pending.fromSide }, { id, side });
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
        current ? { ...current, cursor: toCanvasPoint(live.current, e.clientX, e.clientY, rect) } : current,
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
    // Re-bound only when a connection starts or ends; the cursor updates are
    // written through the state setter and need no fresh listeners.
  }, [pending?.fromId, pending?.fromSide, pending?.startX, pending?.startY]);

  const previewPath = useMemo(() => {
    if (!pending) return null;
    const from = byId.get(pending.fromId);
    if (!from) return null;
    const p1 = sidePoint(from, pending.fromSide);
    return { path: connectorPath(p1, pending.fromSide, pending.cursor, 'left', 'straight') };
  }, [pending, byId]);

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
      cursor: toCanvasPoint(live.current, e.clientX, e.clientY, rect),
      startX: e.clientX,
      startY: e.clientY,
    });
  }

  /**
   * Computes the routing patch for a pointer position and paints it straight
   * into the SVG, so reshaping stays smooth and lands as one committed change.
   */
  function applyRoute(connector: ConnectorElement, axis: 'x' | 'y' | 'free', point: { x: number; y: number }) {
    const from = byIdRef.current.get(connector.from);
    const to = byIdRef.current.get(connector.to);
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

  const startRouteGesture = useCallback(
    (e: React.PointerEvent, connector: ConnectorElement, axis: 'x' | 'y' | 'free') => {
      e.stopPropagation();
      e.preventDefault();
      gesture.current = { kind: 'route', connector, axis, moved: false, patch: {} };
    },
    [],
  );

  function startElementGesture(e: React.PointerEvent, element: CanvasElement) {
    if (spaceRef.current) return; // space always pans, whatever is under the cursor
    if (gesture.current?.kind === 'pinch') return;
    // Let the press through to the board so a shape can be drawn over anything.
    if (props.shapeTool && props.editable) return;
    // Likewise an element being placed can go on top of another.
    if (props.placing && props.editable) return;
    // With the connector tool on, pressing an element's body starts a
    // connection from its nearest side rather than moving it.
    if (props.connectorTool && props.editable) {
      const rect = surface.current?.getBoundingClientRect();
      if (rect) {
        const cursor = toCanvasPoint(live.current, e.clientX, e.clientY, rect);
        const side = ANCHOR_SIDES.reduce((best, candidate) => {
          const a = sidePoint(element, candidate);
          const b = sidePoint(element, best);
          return Math.hypot(a.x - cursor.x, a.y - cursor.y) < Math.hypot(b.x - cursor.x, b.y - cursor.y)
            ? candidate
            : best;
        }, ANCHOR_SIDES[0]);
        startPortDrag(e, element.id, side);
      }
      return;
    }
    e.stopPropagation();
    tabbedTo.current = null;
    // A drag whose release never arrived must not leave its offset behind.
    if (gesture.current) abandonGesture();

    // Editing a text element must not start a drag from inside the textarea.
    if (editingId === element.id) return;

    // Pressing any member of a group takes hold of the whole group.
    const group = withGroups([element.id], groups);
    const additive = e.shiftKey;
    const wasSelected = selectedIds.has(element.id);
    const nextSelection = additive
      ? new Set([...selectedIds, ...group])
      : wasSelected
        ? selectedIds
        : group;
    if (nextSelection !== selectedIds) onSelectionChange(nextSelection);
    if (editingId) setEditingId(null);
    if (!editable) return;

    const origins = new Map<string, { x: number; y: number }>();
    const moving: Rect[] = [];
    for (const id of nextSelection) {
      const el = byId.get(id);
      if (el && el.type !== 'connector') {
        origins.set(id, { x: el.x, y: el.y });
        moving.push(el);
      }
    }
    if (moving.length === 0) return;
    gesture.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origins,
      moved: false,
      pressed: element.id,
      wasSelected: wasSelected && !additive,
      bounds: unionRect(moving),
      others: boxes.filter((el) => !origins.has(el.id)),
      dx: 0,
      dy: 0,
    };
    setPressedId(element.id);
  }

  function startResize(e: React.PointerEvent, element: CanvasElement, corner: Corner) {
    e.stopPropagation();
    if (gesture.current) abandonGesture();
    const origin = { x: element.x, y: element.y, width: element.width, height: element.height };
    gesture.current = {
      kind: 'resize',
      id: element.id,
      corner,
      startX: e.clientX,
      startY: e.clientY,
      origin,
      keepRatio: KEEP_RATIO.has(element.type),
      moved: false,
      last: origin,
      others: boxes.filter((el) => el.id !== element.id),
    };
  }

  function startBackgroundGesture(e: React.PointerEvent) {
    setEditingId(null);
    if (gesture.current?.kind === 'pinch') return;
    if (gesture.current) abandonGesture();
    const view = live.current;
    const panning = e.button === 1 || e.altKey || spaceRef.current;
    // Panning with the middle button, Alt or Space still works while placing.
    if (props.placing && editable && e.button === 0 && !panning) {
      const rect = surface.current?.getBoundingClientRect();
      if (rect) {
        // The new element may open for typing during this press; the press's
        // own mousedown would then move focus to the page and close it again.
        e.preventDefault();
        placedAt.current = Date.now();
        setGhost(null);
        props.onPlace(toCanvasPoint(view, e.clientX, e.clientY, rect), e.shiftKey);
      }
      return;
    }
    if (props.shapeTool && editable && e.button === 0 && !panning) {
      gesture.current = { kind: 'draw', startX: e.clientX, startY: e.clientY };
      return;
    }
    // A mouse drag on empty board selects what it encloses, as in most
    // drawing tools; a finger drag pans, because that is what a finger means.
    if (e.pointerType === 'mouse' && e.button === 0 && !panning) {
      if (!e.shiftKey) onSelectionChange(new Set());
      gesture.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, additive: e.shiftKey };
      return;
    }
    if (!panning) onSelectionChange(new Set());
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y };
  }

  /**
   * Keyboard focus landing on an element selects it and brings it into view,
   * so Tab walks the board the way a pointer would.
   */
  function onElementFocus(e: React.FocusEvent<HTMLDivElement>, element: CanvasElement) {
    if (e.target !== e.currentTarget || !e.currentTarget.matches(':focus-visible')) return;
    if (!refocusing.current) tabbedTo.current = element.id;
    refocusing.current = false;
    if (!selectedIds.has(element.id)) onSelectionChange(new Set([element.id]));
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    const view = live.current;
    const left = element.x * view.scale + view.x;
    const top = element.y * view.scale + view.y;
    const right = left + element.width * view.scale;
    const bottom = top + element.height * view.scale;
    const margin = 40;
    if (left >= margin && top >= margin && right <= rect.width - margin && bottom <= rect.height - margin) return;
    setViewport({
      ...view,
      x: rect.width / 2 - (element.x + element.width / 2) * view.scale,
      y: rect.height / 2 - (element.y + element.height / 2) * view.scale,
    });
  }

  const announcement = useMemo(() => {
    if (selectedIds.size === 0) return '';
    const first = groups.get([...selectedIds][0]);
    if (first && first.length === selectedIds.size && first.every((id) => selectedIds.has(id))) {
      return `Group of ${first.length} items selected`;
    }
    if (selectedIds.size > 1) return `${selectedIds.size} items selected`;
    const element = byId.get([...selectedIds][0]);
    return element ? `${labelOf(element)}, selected` : '';
  }, [selectedIds, byId, labelOf, groups]);

  const handle = (px: number) => px / viewport.scale;

  return (
    <div
      ref={surface}
      role="application"
      aria-roledescription="canvas"
      aria-label="Canvas board. Tab moves between items; Enter edits the selected item."
      onPointerDownCapture={trackTouch}
      onPointerMove={(e) => {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect) return;
        lastPointer.current = toCanvasPoint(live.current, e.clientX, e.clientY, rect);
        if (props.placing) setGhost(lastPointer.current);
        props.onPointer?.(lastPointer.current);
      }}
      onPointerLeave={() => {
        setGhost(null);
        props.onPointer?.(null);
      }}
      // Focusing an element near the edge can scroll this box even though its
      // overflow is hidden, which would shift every screen-to-canvas conversion.
      onScroll={(e) => {
        e.currentTarget.scrollTop = 0;
        e.currentTarget.scrollLeft = 0;
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
        props.onFiles(files, toCanvasPoint(live.current, e.clientX, e.clientY, rect));
      }}
      onPointerDown={startBackgroundGesture}
      onDoubleClick={(e) => {
        if (!editable) return;
        const rect = surface.current?.getBoundingClientRect();
        if (!rect || e.target !== surface.current) return;
        if (props.placing || Date.now() - placedAt.current < 500) return;
        // Double-clicking empty space drops a note there, as on other boards.
        props.onCreateNoteAt(toCanvasPoint(live.current, e.clientX, e.clientY, rect));
      }}
      className={cx(
        // No text selection: in a browser a drag would otherwise highlight
        // the text it passes over instead of moving the element.
        'relative h-full w-full touch-none select-none overflow-hidden bg-[var(--color-canvas)] outline-none',
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
          // Media plays in place once selected; before that a press selects and drags it.
          const interactive =
            editing || (selected && LIVE_WHEN_SELECTED.has(element.type) && pressedId !== element.id);
          const soleSelection = selected && selectedIds.size === 1;
          return (
            <div
              key={element.id}
              ref={(node) => {
                if (node) nodes.current.set(element.id, node);
                else nodes.current.delete(element.id);
              }}
              data-canvas-element={element.id}
              tabIndex={0}
              role="group"
              aria-label={labelOf(element)}
              onFocus={(e) => onElementFocus(e, element)}
              onPointerEnter={() => props.connectorTool && setHoverId(element.id)}
              onPointerLeave={() => !pending && setHoverId((id) => (id === element.id ? null : id))}
              onPointerDown={(e) => startElementGesture(e, element)}
              // Media and links are natively draggable; a native drag cancels
              // the pointer stream, so it must never start from an element.
              onDragStart={(e) => e.preventDefault()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!editable) return;
                // Document cards edit in place; the header's expand button opens full page.
                if (EDITABLE.has(element.type)) setEditingId(element.id);
              }}
              className={cx(
                'absolute focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-dashed focus-visible:outline-[var(--color-accent)]',
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

              {/* Interiors stay inert unless this element is being edited (or is
                  selected media), so a click always reaches the wrapper and starts a drag. */}
              <div
                className={cx(
                  'h-full w-full',
                  editing && 'select-text',
                  !interactive && (element.type === 'link' ? '[&_*]:pointer-events-none' : 'pointer-events-none'),
                )}
                onPointerDown={
                  interactive && !editing
                    ? (e) => {
                        // Scrubbing or pressing play must not also move the element.
                        if ((e.target as HTMLElement).closest('video, audio')) e.stopPropagation();
                      }
                    : undefined
                }
              >
                <CanvasElementView
                  element={element}
                  selected={selected}
                  editing={editing}
                  dark={props.dark}
                  members={props.members}
                  onUpdate={onUpdate}
                  onStopEditing={stopEditing}
                  onOpenDocument={onOpenDocument}
                />
              </div>

              {props.connectorTool && editable && (hoverId === element.id || pending?.fromId === element.id) &&
                ANCHOR_SIDES.map((side) => {
                  const point = sidePoint(element, side);
                  // A generous invisible target around a visible dot: the dot
                  // says where, the target makes it easy to hit, by finger too.
                  const hit = handle(28);
                  const dot = handle(12);
                  return (
                    <div
                      key={side}
                      data-port-side={side}
                      onPointerDown={(e) => startPortDrag(e, element.id, side)}
                      title={`Connect from the ${side}`}
                      className="pointer-events-auto absolute grid place-items-center"
                      style={{
                        left: point.x - element.x - hit / 2,
                        top: point.y - element.y - hit / 2,
                        width: hit,
                        height: hit,
                      }}
                    >
                      <span
                        className="block rounded-full border-white bg-[var(--color-accent)]"
                        style={{ width: dot, height: dot, borderWidth: handle(2) }}
                      />
                    </div>
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
                  title="Add a child node (Tab)"
                  className="absolute grid place-items-center rounded-full border-2 border-white bg-[var(--color-accent)] font-semibold text-white shadow"
                  style={{
                    // Sized in screen pixels so it stays usable at any zoom.
                    width: handle(22),
                    height: handle(22),
                    fontSize: handle(15),
                    right: -handle(30),
                    top: `calc(50% - ${handle(11)}px)`,
                  }}
                >
                  <Icon name="plus-lg" />
                </button>
              )}

              {/* A live video or embed fills its box with controls, so it gets a
                  handle to move by. The press bubbles to the wrapper's drag. */}
              {selected && editable && !editing && (element.type === 'video' || element.type === 'embed') && (
                <div
                  aria-hidden
                  className="absolute left-1/2 grid -translate-x-1/2 cursor-move place-items-center rounded-full bg-[var(--color-accent)] text-white shadow"
                  style={{
                    // Sized in screen pixels so it stays usable at any zoom.
                    width: handle(36),
                    height: handle(16),
                    fontSize: handle(14),
                    top: -handle(22),
                  }}
                >
                  <Icon name="grip-horizontal" />
                </div>
              )}

              {soleSelection && editable && !editing && !props.connectorTool &&
                CORNERS.map((corner) => (
                  <div
                    key={corner}
                    aria-hidden
                    onPointerDown={(e) => startResize(e, element, corner)}
                    className={cx(
                      'absolute rounded-sm border border-white bg-[var(--color-accent)]',
                      corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
                    )}
                    style={{
                      width: handle(10),
                      height: handle(10),
                      [corner.includes('n') ? 'top' : 'bottom']: -handle(6),
                      [corner.includes('w') ? 'left' : 'right']: -handle(6),
                    }}
                  />
                ))}
            </div>
          );
        })}

        {props.pendingBoxes.map((box) => (
          <div
            key={box.id}
            role="status"
            className="pointer-events-none absolute grid place-items-center rounded-lg border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/5"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          >
            <div className="flex max-w-full flex-col items-center gap-2 px-3 text-center text-[var(--color-muted)]">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" />
              <span className="max-w-full truncate text-xs">{box.label}</span>
            </div>
          </div>
        ))}

        {selectedGroups.map((box, i) => (
          <div
            key={i}
            aria-hidden
            className="pointer-events-none absolute rounded-lg border-dashed border-[var(--color-accent)]"
            style={{
              left: box.x - handle(8),
              top: box.y - handle(8),
              width: box.width + handle(16),
              height: box.height + handle(16),
              borderWidth: handle(1.5),
            }}
          />
        ))}

        {guides.map((guide) => (
          <div
            key={`${guide.axis}-${guide.at}`}
            aria-hidden
            className="pointer-events-none absolute bg-rose-500"
            style={
              guide.axis === 'x'
                ? { left: guide.at - handle(0.5), top: guide.from - handle(12), width: handle(1), height: guide.to - guide.from + handle(24) }
                : { top: guide.at - handle(0.5), left: guide.from - handle(12), height: handle(1), width: guide.to - guide.from + handle(24) }
            }
          />
        ))}

        <Connectors
          connectors={connectors}
          byId={byId}
          selectedIds={selectedIds}
          preview={previewPath}
          mindEdges={mindEdges}
          scale={viewport.scale}
          editable={editable}
          onRouteHandleDown={startRouteGesture}
          onSelect={onSelectConnector}
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

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
