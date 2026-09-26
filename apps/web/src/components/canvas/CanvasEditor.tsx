import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONNECTOR_COLORS,
  DEFAULT_SIZE,
  NOTE_COLORS,
  NODE_COLORS,
  NODE_GAP_X,
  NODE_GAP_Y,
  SHAPE_FILLS,
  SHAPE_KINDS,
  canvasSearchText,
  type AnchorSide,
  type CanvasElement,
  type ConnectorDash,
  type ConnectorElement,
  type ConnectorShape,
  type Doc,
  type FrameElement,
  type MindNodeElement,
  type NoteElement,
  type ShapeElement,
  type ShapeKind,
  type WorkspaceMember,
  isWebUrl,
} from '@paradocs/shared';
import type { CollabSession, Peer } from '../../lib/collaboration';
import { boundsOf, useCanvasElements } from '../../lib/canvasStore';
import { alignBoxes, colorName, distributeBoxes, type Alignment } from '../../lib/canvasArrange';
import { peerPointer, usePublishPointer } from '../../lib/canvasPresence';
import { cx, randomId, useAutosave, useDebounced } from '../../lib/util';
import { claimNewDocument } from '../../lib/newDocuments';
import { useAppEnabled, useCreateDocument, useLinkTargets, useMembers, useUploadFile, type DocumentPatch } from '../../api/hooks';
import { useToast } from '../Toast';
import CanvasSurface, { MAX_SCALE, MIN_SCALE, zoomAround, type PendingBox, type Viewport } from './CanvasSurface';
import PresentMode from './PresentMode';
import PeerCursors from './PeerCursors';
import { Modal } from '../Modal';
import { Popover } from '../Popover';
import { Button, Tooltip } from '../ui';
import Avatar from '../Avatar';
import Icon, { type IconName } from '../Icon';
import SheetRefPicker from '../sheet/SheetRefPicker';
import { WorkItemPicker } from '../projects/WorkItemRefs';
import { withCachedSheetValues } from '../../lib/sheetRefs';
import { serverPath } from '../../lib/server';

interface Props {
  doc: Doc;
  workspaceId: string;
  canEdit: boolean;
  dark: boolean;
  session: CollabSession;
  peers: Peer[];
  onPatch: (patch: DocumentPatch) => void;
  onOpenDocument: (documentId: string) => void;
}

type Inserting = { type: 'embed' | 'image' | 'audio' | 'video' | 'link' } | null;

/**
 * What a press on the board does. One value rather than a flag per tool, so
 * picking any tool puts the previous one away and nothing can be half on.
 *
 * A `place` tool waits for a click on the board to say where its element
 * goes; nothing is created until then, so picking a tool and changing your
 * mind leaves the board — and the workspace — as it was.
 */
type Tool =
  | { kind: 'select' }
  | { kind: 'shape'; shape: ShapeKind }
  | { kind: 'connector' }
  | {
      kind: 'place';
      /** Which toolbar button armed it, so that button shows as on. */
      id: 'note' | 'text' | 'node' | 'frame';
      type: CanvasElement['type'];
      /** What is being placed, for the hint: "sticky note". */
      label: string;
      /** `keep` is set when the element is one of several placed in a row. */
      place: (point: { x: number; y: number }, keep: boolean) => void;
    };

const SELECT: Tool = { kind: 'select' };

/**
 * The elements whose text is the point of them. Adding one is almost always
 * the first half of writing something, so it is opened for typing straight
 * away rather than waiting to be double-clicked — and a tool used to draw it
 * puts itself away, because the next thing wanted is the keyboard, not another
 * shape.
 */
const TEXT_ELEMENTS = new Set<CanvasElement['type']>(['note', 'text', 'shape', 'node', 'frame']);

const SHAPE_ICONS: Record<ShapeKind, IconName> = {
  rectangle: 'square',
  ellipse: 'circle',
  diamond: 'diamond',
  triangle: 'triangle',
};

const EMPTY_MEMBERS: WorkspaceMember[] = [];

/** Copied elements travel under their own type, beside the plain text other apps can use. */
const CLIPBOARD_TYPE = 'application/x-paradocs-canvas';

/**
 * The last copy, for browsers that drop custom clipboard types: a paste whose
 * text matches what was copied is taken to be that copy.
 */
let lastCopy: { text: string; elements: CanvasElement[] } | null = null;

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** How far one press of an arrow key moves the selection, and with Shift. */
const NUDGE = 1;
const NUDGE_FAR = 10;

export default function CanvasEditor({
  doc,
  workspaceId,
  canEdit,
  dark,
  session,
  peers,
  onPatch,
  onOpenDocument,
}: Props) {
  const {
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
    canUndo,
    canRedo,
  } = useCanvasElements(session.ydoc);
  const createDocument = useCreateDocument(workspaceId);
  const uploadFile = useUploadFile(workspaceId);
  // Who can be tagged on this board, and whose names its tags resolve to.
  const members = useMembers(workspaceId);
  const memberList = members.data ?? EMPTY_MEMBERS;
  const toast = useToast();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const publishPointer = usePublishPointer(session);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>(SELECT);
  // Opens an element for typing; the sequence lets the same one be asked for twice.
  const [editRequest, setEditRequest] = useState<{ id: string; seq: number } | null>(null);
  const requestEdit = useCallback((id: string) => setEditRequest((r) => ({ id, seq: (r?.seq ?? 0) + 1 })), []);
  const [inserting, setInserting] = useState<Inserting>(null);
  const [sheetInserting, setSheetInserting] = useState<'cell' | 'chart' | null>(null);
  const sheetsOn = useAppEnabled(workspaceId, 'sheets');
  const projectsOn = useAppEnabled(workspaceId, 'projects');
  const [itemInserting, setItemInserting] = useState(false);
  const [pendingBoxes, setPendingBoxes] = useState<PendingBox[]>([]);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [title, setTitle] = useState(doc.title);

  const byId = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);
  const selected = useMemo(
    () => [...selectedIds].map((id) => byId.get(id)).filter((el): el is CanvasElement => Boolean(el)),
    [selectedIds, byId],
  );

  // An undo can take away an element that is selected; the selection follows.
  useEffect(() => {
    setSelectedIds((current) => {
      const kept = [...current].filter((id) => byId.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [byId]);

  const titleSave = useAutosave<string>((value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== doc.title) onPatch({ title: trimmed });
  }, 600);

  const titleRef = useRef<HTMLInputElement>(null);
  /**
   * A canvas that has just been made opens on its own name, selected, the same
   * way a page does: "Untitled" is a prompt for a name, not one.
   */
  useEffect(() => {
    if (!canEdit || !claimNewDocument(doc.id)) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [doc.id, canEdit]);

  const frames = useMemo(
    () =>
      elements
        .filter((el): el is FrameElement => el.type === 'frame')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [elements],
  );

  const boardRect = () => document.getElementById('paradocs-canvas')?.getBoundingClientRect() ?? null;

  /** The canvas point at the middle of what is on screen. */
  function viewCentre() {
    const rect = boardRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (rect.width / 2 - viewport.x) / viewport.scale,
      y: (rect.height / 2 - viewport.y) / viewport.scale,
    };
  }

  /**
   * A point near `point` where an element centred on it will not sit exactly
   * on top of another, so several things added in a row stay visible.
   */
  function freeSpotNear(point: { x: number; y: number }, size: { width: number; height: number }) {
    let spot = point;
    for (let i = 0; i < 20; i++) {
      const x = spot.x - size.width / 2;
      const y = spot.y - size.height / 2;
      const clash = elements.some((el) => el.type !== 'connector' && Math.abs(el.x - x) < 8 && Math.abs(el.y - y) < 8);
      if (!clash) return spot;
      spot = { x: spot.x + 28, y: spot.y + 28 };
    }
    return spot;
  }

  /** Creates an element centred on a point. */
  const addElement = useCallback(
    (
      type: CanvasElement['type'],
      point: { x: number; y: number },
      extra: Partial<CanvasElement> = {},
      edit = TEXT_ELEMENTS.has(type),
    ) => {
      const size = DEFAULT_SIZE[type];
      const id = create(type, {
        x: point.x - size.width / 2,
        y: point.y - size.height / 2,
        ...extra,
      } as never);
      setSelectedIds(new Set([id]));
      if (edit) requestEdit(id);
      return id;
    },
    [create, requestEdit],
  );

  /** Adds an element chosen from the Insert menu in the middle of the view, where it can be seen. */
  function addAtCentre(type: CanvasElement['type'], extra: Partial<CanvasElement>) {
    return addElement(type, freeSpotNear(viewCentre(), DEFAULT_SIZE[type]), extra);
  }

  /** A toolbar button that places an element on the next click: press to arm, press again to put it away. */
  function placeTool(
    id: Extract<Tool, { kind: 'place' }>['id'],
    type: CanvasElement['type'],
    label: string,
    extra: () => Partial<CanvasElement> = () => ({}),
  ) {
    setTool((current) =>
      current.kind === 'place' && current.id === id
        ? SELECT
        : {
            kind: 'place',
            id,
            type,
            label,
            // Several placed in a row are not each opened for typing.
            place: (point, keep) => addElement(type, point, extra(), !keep && TEXT_ELEMENTS.has(type)),
          },
    );
  }

  const tools = {
    note: () => placeTool('note', 'note', 'sticky note', () => ({ text: '', color: NOTE_COLORS[0] }) as Partial<CanvasElement>),
    text: () => placeTool('text', 'text', 'text', () => ({ text: '' }) as Partial<CanvasElement>),
    node: () => placeTool('node', 'node', 'mind map', () => ({ text: '', color: NODE_COLORS[0] }) as Partial<CanvasElement>),
    frame: () =>
      placeTool('frame', 'frame', 'frame', () => ({ name: `Frame ${frames.length + 1}`, order: frames.length }) as Partial<CanvasElement>),
    shape: () => setTool((current) => (current.kind === 'shape' ? SELECT : { kind: 'shape', shape: 'rectangle' })),
    connector: () => setTool((current) => (current.kind === 'connector' ? SELECT : { kind: 'connector' })),
    select: () => setTool(SELECT),
  };

  /** Shows a placeholder while something is being made, and takes it away however that ends. */
  async function withPlaceholder<T>(box: Omit<PendingBox, 'id'>, work: () => Promise<T>): Promise<T> {
    const id = randomId();
    setPendingBoxes((boxes) => [...boxes, { ...box, id }]);
    try {
      return await work();
    } finally {
      setPendingBoxes((boxes) => boxes.filter((b) => b.id !== id));
    }
  }

  /**
   * Creates a real document in the workspace and adds a card for it, so a
   * board can spawn the documents it references without leaving the canvas.
   */
  async function createDocumentCard() {
    const size = DEFAULT_SIZE.link;
    const point = freeSpotNear(viewCentre(), size);
    try {
      const made = await withPlaceholder(
        { x: point.x - size.width / 2, y: point.y - size.height / 2, ...size, label: 'Creating document…' },
        () => createDocument.mutateAsync({ title: 'Untitled', folderId: null }),
      );
      addElement('link', point, { documentId: made.id, title: made.title } as Partial<CanvasElement>);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the document', 'error');
    }
  }

  /** Maps a file's type to the element that should hold it. */
  function elementTypeFor(file: File): 'image' | 'audio' | 'video' | null {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('video/')) return 'video';
    return null;
  }

  /**
   * Uploads dropped or pasted files and lays them out from the drop point.
   * Each shows as a placeholder straight away, so a slow upload is visibly
   * under way rather than looking as if the drop did nothing.
   */
  async function handleFiles(files: File[], point: { x: number; y: number }) {
    if (!canEdit) return;
    let offset = 0;
    const jobs: Promise<string | null>[] = [];
    for (const file of files) {
      const type = elementTypeFor(file);
      if (!type) {
        toast(`${file.name} is not an image, audio or video file`, 'error');
        continue;
      }
      const size = DEFAULT_SIZE[type];
      const x = point.x - size.width / 2 + offset;
      const y = point.y - size.height / 2 + offset;
      offset += 28;
      jobs.push(
        withPlaceholder({ x, y, ...size, label: `Uploading ${file.name}` }, async () => {
          try {
            // Attribute the file to this canvas so it is not listed as orphaned.
            const uploaded = await uploadFile.mutateAsync({ file, documentId: doc.id });
            return create(type, {
              x,
              y,
              url: serverPath(uploaded.url),
              title: file.name,
              alt: file.name,
            } as never);
          } catch (err) {
            toast(err instanceof Error ? err.message : `Could not upload ${file.name}`, 'error');
            return null;
          }
        }),
      );
    }
    const created = (await Promise.all(jobs)).filter((id): id is string => Boolean(id));
    // Select what landed, so its style bar and resize handles are available.
    if (created.length) setSelectedIds(new Set(created));
  }

  /**
   * Adds a child under any node, at any depth. New children stack below their
   * existing siblings so a branch grows downward without overlapping.
   */
  function addChild(parentId: string) {
    const parent = byId.get(parentId);
    if (!parent || parent.type !== 'node') return;

    const siblings = elements.filter(
      (el): el is MindNodeElement => el.type === 'node' && el.parentId === parentId,
    );
    const size = DEFAULT_SIZE.node;
    const y =
      siblings.length === 0
        ? parent.y + parent.height / 2 - size.height / 2
        : Math.max(...siblings.map((s) => s.y + s.height)) + NODE_GAP_Y;

    const id = create('node', {
      x: parent.x + parent.width + NODE_GAP_X,
      y,
      width: size.width,
      height: size.height,
      text: '',
      parentId,
      color: parent.color ?? NODE_COLORS[0],
    } as never);
    setSelectedIds(new Set([id]));
    requestEdit(id);
  }

  function addSibling(nodeId: string) {
    const node = byId.get(nodeId);
    if (node?.type === 'node' && node.parentId) addChild(node.parentId);
  }

  function deleteSelection() {
    if (selectedIds.size === 0) return;
    remove([...selectedIds]);
    setSelectedIds(new Set());
  }

  /** The selection, plus any connector running between two selected elements. */
  function selectionWithConnectors() {
    const chosen = elements.filter((el) => selectedIds.has(el.id));
    const ids = new Set(chosen.map((el) => el.id));
    for (const el of elements) {
      if (el.type === 'connector' && !ids.has(el.id) && ids.has(el.from) && ids.has(el.to)) chosen.push(el);
    }
    return chosen;
  }

  /** Makes the selected elements one group; groups already in the selection merge into it. */
  function groupSelection() {
    const members = selected.filter((el) => el.type !== 'connector');
    if (members.length < 2) return;
    const groupId = randomId();
    updateMany(members.map((el) => ({ id: el.id, patch: { groupId } as Partial<CanvasElement> })));
  }

  function ungroupSelection() {
    const grouped = selected.filter((el) => el.groupId);
    if (grouped.length === 0) return;
    updateMany(grouped.map((el) => ({ id: el.id, patch: { groupId: undefined } as Partial<CanvasElement> })));
  }

  function duplicateSelection() {
    const chosen = selectionWithConnectors();
    if (chosen.length === 0) return;
    const created = insertCopies(chosen, 24, 24);
    if (created.length) setSelectedIds(new Set(created));
  }

  /** Pastes copied elements so they land centred on the point. */
  function pasteElements(source: CanvasElement[], point: { x: number; y: number }) {
    const bounds = boundsOf(source);
    if (!bounds) return;
    const created = insertCopies(
      source,
      point.x - (bounds.x + bounds.width / 2),
      point.y - (bounds.y + bounds.height / 2),
    );
    if (created.length) setSelectedIds(new Set(created));
  }

  function onPasteData(data: DataTransfer, point: { x: number; y: number }) {
    let source: CanvasElement[] | null = null;
    try {
      const raw = data.getData(CLIPBOARD_TYPE);
      if (raw) source = (JSON.parse(raw) as { elements: CanvasElement[] }).elements;
    } catch {
      source = null;
    }
    if (!source && lastCopy && data.getData('text/plain') === lastCopy.text) source = lastCopy.elements;
    if (!source?.length) return false;
    pasteElements(source, point);
    return true;
  }

  /**
   * Copying with elements selected, and no text selected, copies them — as
   * elements for pasting back onto a board, and as what they say for anywhere
   * else, with each spreadsheet cell as the value it shows and each chart as
   * its numbers, so a board's figures paste as figures rather than as nothing.
   */
  const clipboardState = useRef({ selectionWithConnectors, deleteSelection, canEdit, members: memberList });
  clipboardState.current = { selectionWithConnectors, deleteSelection, canEdit, members: memberList };
  useEffect(() => {
    function write(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return false;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return false;
      const chosen = clipboardState.current.selectionWithConnectors();
      if (chosen.length === 0 || !event.clipboardData) return false;
      const names = new Map(clipboardState.current.members.map((member) => [member.userId, member.name]));
      const text =
        withCachedSheetValues(canvasSearchText(chosen, names)).trim() ||
        `${chosen.length} canvas item${chosen.length === 1 ? '' : 's'}`;
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify({ elements: chosen }));
      lastCopy = { text, elements: chosen };
      event.preventDefault();
      return true;
    }
    const onCopy = (event: ClipboardEvent) => void write(event);
    const onCut = (event: ClipboardEvent) => {
      if (!clipboardState.current.canEdit) return;
      if (write(event)) clipboardState.current.deleteSelection();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
    };
  }, []);

  function completeConnection(
    from: { id: string; side: AnchorSide },
    to: { id: string; side: AnchorSide },
  ) {
    if (from.id === to.id) return;
    const id = create('connector', {
      x: 0,
      y: 0,
      from: from.id,
      to: to.id,
      fromSide: from.side,
      toSide: to.side,
      shape: 'straight',
      dash: 'solid',
      arrowStart: false,
      arrowEnd: true,
    } as never);
    setSelectedIds(new Set([id]));
  }

  /** Centres the board on where a collaborator's pointer is, or last was, at the current zoom. */
  function jumpToPeer(clientId: number) {
    const point = peerPointer(session, clientId);
    const rect = boardRect();
    if (!point || !rect) return;
    setViewport((current) => ({
      ...current,
      x: rect.width / 2 - point.x * current.scale,
      y: rect.height / 2 - point.y * current.scale,
    }));
  }

  /** Frames a set of elements — the whole board, or the selection. */
  function zoomToFit(target: CanvasElement[] = elements) {
    const bounds = boundsOf(target);
    const rect = boardRect();
    if (!bounds || !rect) return;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(
      (rect.width - 80) / Math.max(1, bounds.width),
      (rect.height - 80) / Math.max(1, bounds.height),
    )));
    setViewport({
      scale,
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
    });
  }

  /** Zooms about the middle of the view, which stays where it is. */
  function zoomTo(scale: number) {
    const rect = boardRect();
    if (!rect) return;
    setViewport((current) => zoomAround(current, scale, { x: rect.width / 2, y: rect.height / 2 }));
  }

  function nudge(dx: number, dy: number) {
    const moving = selected.filter((el) => el.type !== 'connector');
    if (moving.length === 0) return;
    updateMany(moving.map((el) => ({ id: el.id, patch: { x: el.x + dx, y: el.y + dy } as Partial<CanvasElement> })));
  }

  // Board-wide shortcuts. The board's own keys (Delete, Enter, Escape, Space)
  // are handled where the selection and editing live, in the surface.
  const keyState = useRef({ undo, redo, duplicateSelection, groupSelection, ungroupSelection, nudge, zoomTo, zoomToFit, tools, viewport, elements, selected });
  keyState.current = { undo, redo, duplicateSelection, groupSelection, ungroupSelection, nudge, zoomTo, zoomToFit, tools, viewport, elements, selected };
  const busy = presenting !== null || inserting !== null || sheetInserting !== null || itemInserting;
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (/input|textarea|select/i.test(target.tagName) || target.isContentEditable)) return;
      if (target?.closest('[role="dialog"], [role="menu"]')) return;
      const k = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (e.key === 'Escape') {
        setTool(SELECT);
        return;
      }
      // Zoom works for everyone; changing the board only for editors.
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        k.zoomTo(k.viewport.scale * 1.25);
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        k.zoomTo(k.viewport.scale / 1.25);
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        k.zoomTo(1);
        return;
      }
      if (e.shiftKey && !mod && e.code === 'Digit1') {
        e.preventDefault();
        k.zoomToFit();
        return;
      }
      if (e.shiftKey && !mod && e.code === 'Digit2') {
        e.preventDefault();
        if (k.selected.length) k.zoomToFit(k.selected);
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(k.elements.map((el) => el.id)));
        return;
      }
      if (!canEdit) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) k.redo();
        else k.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        k.redo();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        k.duplicateSelection();
        return;
      }
      if (mod && key === 'g') {
        e.preventDefault();
        if (e.shiftKey) k.ungroupSelection();
        else k.groupSelection();
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      if (arrows[e.key] && !mod && !e.altKey && k.selected.length) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE_FAR : NUDGE;
        k.nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
        return;
      }
      if (mod || e.altKey || e.shiftKey) return;
      const letters: Record<string, () => void> = {
        v: k.tools.select,
        n: k.tools.note,
        t: k.tools.text,
        s: k.tools.shape,
        c: k.tools.connector,
        m: k.tools.node,
        f: k.tools.frame,
      };
      if (letters[key]) {
        e.preventDefault();
        letters[key]();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, canEdit]);

  const placing = tool.kind === 'place' ? tool : null;
  const isActive = (id: string) =>
    (tool.kind === 'place' && tool.id === id) || tool.kind === id || (id === 'select' && tool.kind === 'select');

  return (
    <div className="flex h-full flex-col">
      <div
        role="toolbar"
        aria-label="Canvas tools"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-line)] px-3 py-2"
      >
        <input
          ref={titleRef}
          value={title}
          readOnly={!canEdit}
          aria-label="Canvas name"
          onChange={(e) => {
            setTitle(e.target.value);
            titleSave.schedule(e.target.value);
          }}
          onBlur={() => titleSave.flush()}
          placeholder="Untitled canvas"
          className="min-w-32 max-w-64 flex-1 border-0 bg-transparent text-base font-semibold outline-none"
        />

        {canEdit && (
          <>
            <Divider />
            <ToolButton label="Select" shortcut="V" active={isActive('select')} onClick={tools.select}>
              <Icon name="cursor" />
            </ToolButton>
            <ToolButton label="Sticky note" shortcut="N" active={isActive('note')} onClick={tools.note}>
              <Icon name="sticky" />
            </ToolButton>
            <ToolButton label="Text" shortcut="T" active={isActive('text')} onClick={tools.text}>
              <Icon name="fonts" />
            </ToolButton>
            <ToolButton label="Shape" shortcut="S" active={isActive('shape')} onClick={tools.shape}>
              <Icon name="pentagon" />
            </ToolButton>
            <ToolButton label="Connector" shortcut="C" active={isActive('connector')} onClick={tools.connector}>
              <Icon name="arrow-left-right" />
            </ToolButton>
            <ToolButton label="Mind map" shortcut="M" active={isActive('node')} onClick={tools.node}>
              <Icon name="diagram-3" />
            </ToolButton>
            <ToolButton label="Frame (slide)" shortcut="F" active={isActive('frame')} onClick={tools.frame}>
              <Icon name="aspect-ratio" />
            </ToolButton>
            <Divider />
            <InsertMenu
              sheetsOn={sheetsOn}
              projectsOn={projectsOn}
              onPick={(choice) => {
                setTool(SELECT);
                if (choice === 'newDocument') void createDocumentCard();
                else if (choice === 'sheetCell' || choice === 'sheetChart') setSheetInserting(choice === 'sheetCell' ? 'cell' : 'chart');
                else if (choice === 'workItem') setItemInserting(true);
                else setInserting({ type: choice });
              }}
            />
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {peers.length > 0 && (
            <div className="mr-1 flex -space-x-1.5">
              {peers.slice(0, 4).map((peer) => (
                <Tooltip key={peer.clientId} label={`Go to ${peer.name}`}>
                  <button
                    aria-label={`Go to where ${peer.name} is on the board`}
                    onClick={() => jumpToPeer(peer.clientId)}
                    className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
                  >
                    <Avatar
                      name={peer.name}
                      url={peer.avatarUrl}
                      className="border-2 border-[var(--color-canvas)]"
                      style={{ background: peer.color, boxShadow: `0 0 0 1.5px ${peer.color}` }}
                    />
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
          {canEdit && (
            <>
              <ToolButton label="Undo" shortcut={`${MOD}Z`} disabled={!canUndo} onClick={undo}>
                <Icon name="arrow-counterclockwise" />
              </ToolButton>
              <ToolButton label="Redo" shortcut={IS_MAC ? '⇧⌘Z' : 'Ctrl+Y'} disabled={!canRedo} onClick={redo}>
                <Icon name="arrow-clockwise" />
              </ToolButton>
            </>
          )}
          <Tooltip label={frames.length ? 'Present the frames as slides' : 'Add a frame to present its contents as a slide'}>
            <Button
              variant="subtle"
              className={cx('text-sm', frames.length === 0 && 'opacity-50')}
              aria-disabled={frames.length === 0}
              onClick={() => frames.length && setPresenting(0)}
            >
              <Icon name="play-fill" /> Present
            </Button>
          </Tooltip>
        </div>
      </div>

      <div id="paradocs-canvas" className="relative min-h-0 flex-1">
        <CanvasSurface
          elements={elements}
          viewport={viewport}
          onViewportChange={setViewport}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          editable={canEdit}
          members={memberList}
          connectorTool={tool.kind === 'connector'}
          shapeTool={tool.kind === 'shape' ? tool.shape : null}
          placing={placing ? DEFAULT_SIZE[placing.type] : null}
          onPlace={(point, keep) => {
            if (!placing) return;
            // One element per pick unless Shift asks for more.
            if (!keep) setTool(SELECT);
            placing.place(point, keep);
          }}
          onDrawShape={(rect, keep) => {
            const id = create('shape', {
              ...rect,
              shape: tool.kind === 'shape' ? tool.shape : 'rectangle',
              text: '',
              fill: SHAPE_FILLS[1],
              stroke: CONNECTOR_COLORS[1],
              strokeWidth: 2,
              dash: 'solid',
            } as never);
            setSelectedIds(new Set([id]));
            if (keep) return;
            // The shape has been drawn, so the tool has done its job; leaving
            // it armed would turn the next click meant for the label into
            // another shape.
            setTool(SELECT);
            requestEdit(id);
          }}
          onConnect={completeConnection}
          onUpdate={update}
          onCommit={updateMany}
          onBringToFront={bringToFront}
          onOpenDocument={onOpenDocument}
          dark={dark}
          onDeleteSelection={deleteSelection}
          onFiles={handleFiles}
          onPasteData={onPasteData}
          onPointer={publishPointer}
          onAddChild={addChild}
          onAddSibling={addSibling}
          editRequest={editRequest}
          pendingBoxes={pendingBoxes}
          onCreateNoteAt={(point) => addElement('note', point, { text: '', color: NOTE_COLORS[0] } as Partial<CanvasElement>)}
        />

        <PeerCursors session={session} viewport={viewport} />

        {elements.length === 0 && pendingBoxes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="max-w-xs text-center text-sm text-[var(--color-muted)]">
              <p className="font-medium">Empty canvas</p>
              <p className="mt-1 text-xs">
                {canEdit
                  ? 'Double-click anywhere to add a sticky note, or pick a tool above. Drag to select; scroll or hold Space to move around.'
                  : 'Nothing has been added to this canvas yet.'}
              </p>
            </div>
          </div>
        )}

        {/* Controls float over the board rather than stacking above it, so
            selecting something never shifts the board under the pointer. */}
        {canEdit && selected.length > 0 && (
          <SelectionBar
            selected={selected}
            frames={frames}
            onUpdateMany={updateMany}
            onAddChild={addChild}
            onDuplicate={duplicateSelection}
            onGroup={groupSelection}
            onUngroup={ungroupSelection}
            onDelete={deleteSelection}
            onBringToFront={() => bringToFront(selected.map((el) => el.id))}
            onSendToBack={() => sendToBack(selected.map((el) => el.id))}
            onPresentFrom={(frameId) => setPresenting(frames.findIndex((f) => f.id === frameId))}
          />
        )}

        {canEdit && tool.kind !== 'select' && (
          <ToolHint tool={tool} onShape={(shape) => setTool({ kind: 'shape', shape })} onDone={() => setTool(SELECT)} />
        )}

        <ZoomControls
          scale={viewport.scale}
          hasSelection={selected.length > 0}
          onZoom={zoomTo}
          onFit={() => zoomToFit()}
          onFitSelection={() => zoomToFit(selected)}
        />
      </div>

      {inserting && (
        <InsertDialog
          kind={inserting.type}
          workspaceId={workspaceId}
          onCancel={() => setInserting(null)}
          onInsert={(payload) => {
            const type = inserting.type;
            setInserting(null);
            addAtCentre(type, payload as Partial<CanvasElement>);
          }}
          onUpload={(file) => {
            setInserting(null);
            void handleFiles([file], freeSpotNear(viewCentre(), DEFAULT_SIZE[elementTypeFor(file) ?? 'image']));
          }}
        />
      )}

      {itemInserting && (
        <WorkItemPicker
          workspaceId={workspaceId}
          confirmLabel="Add to canvas"
          onCancel={() => setItemInserting(false)}
          onPick={(item) => {
            setItemInserting(false);
            addAtCentre('workItem', { itemId: item.id, label: `${item.key} ${item.title}` } as Partial<CanvasElement>);
          }}
        />
      )}

      {sheetInserting && (
        <SheetRefPicker
          kind={sheetInserting}
          workspaceId={workspaceId}
          confirmLabel="Add to canvas"
          onCancel={() => setSheetInserting(null)}
          onInsert={(ref) => {
            setSheetInserting(null);
            if (ref.kind === 'cell') {
              addAtCentre('sheetCell', {
                spreadsheetId: ref.spreadsheetId,
                sheetId: ref.sheetId,
                cell: ref.cell,
                label: ref.label,
              } as Partial<CanvasElement>);
            } else {
              addAtCentre('sheetChart', {
                spreadsheetId: ref.spreadsheetId,
                sheetId: ref.sheetId,
                chartId: ref.chartId,
                label: ref.label,
              } as Partial<CanvasElement>);
            }
          }}
        />
      )}

      {presenting !== null && (
        <PresentMode
          frames={frames}
          elements={elements}
          startIndex={Math.max(0, presenting)}
          dark={dark}
          members={memberList}
          onExit={() => setPresenting(null)}
          onOpenDocument={onOpenDocument}
        />
      )}
    </div>
  );
}

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px bg-[var(--color-line)]" />;

/** A focus ring for the canvas's own compact controls, matching the shared Button. */
const FOCUS_RING =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]';

const FLOATING_BAR =
  'pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] px-2 py-1.5 text-xs shadow-lg';

/**
 * The body of a dropdown menu. The first item takes focus once the menu is
 * showing (a popover is hidden while it measures itself, so autoFocus would be
 * lost), and the arrow keys move between items.
 */
function MenuPanel({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  useEffect(() => {
    const timer = setTimeout(() => items()[0]?.focus());
    return () => clearTimeout(timer);
  }, []);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    list[(index + step + list.length) % list.length]?.focus();
  }
  return (
    <div ref={panel} role="menu" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}

const MENU_ITEM =
  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface)] ' +
  'outline-none focus-visible:bg-[var(--color-surface)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50';

// --- insert menu ------------------------------------------------------------

type InsertChoice = 'newDocument' | 'link' | 'embed' | 'image' | 'audio' | 'video' | 'sheetCell' | 'sheetChart' | 'workItem';

function InsertMenu({
  sheetsOn,
  projectsOn,
  onPick,
}: {
  sheetsOn: boolean;
  projectsOn: boolean;
  onPick: (choice: InsertChoice) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const groups: { label: string; items: { id: InsertChoice; label: string; icon: IconName }[] }[] = [
    {
      label: 'Documents',
      items: [
        { id: 'newDocument', label: 'New document', icon: 'file-earmark-plus' },
        { id: 'link', label: 'Existing document', icon: 'file-earmark-text' },
      ],
    },
    {
      label: 'Media',
      items: [
        { id: 'image', label: 'Image', icon: 'image' },
        { id: 'video', label: 'Video', icon: 'film' },
        { id: 'audio', label: 'Audio', icon: 'music-note-beamed' },
        { id: 'embed', label: 'Web page or video link', icon: 'play-btn' },
      ],
    },
  ];
  // Nothing to point at in a workspace with Sheets or Projects off.
  const fromWorkspace: { id: InsertChoice; label: string; icon: IconName }[] = [
    ...(sheetsOn
      ? [
          { id: 'sheetCell' as const, label: 'Spreadsheet cell', icon: 'table' as const },
          { id: 'sheetChart' as const, label: 'Spreadsheet chart', icon: 'bar-chart' as const },
        ]
      : []),
    ...(projectsOn ? [{ id: 'workItem' as const, label: 'Work item', icon: 'kanban' as const }] : []),
  ];
  if (fromWorkspace.length) groups.push({ label: 'From the workspace', items: fromWorkspace });

  return (
    <>
      <Tooltip label="Insert documents, media and workspace items">
        <button
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          className={cx(
            'flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
            anchor ? 'bg-[var(--color-surface)]' : 'hover:bg-[var(--color-surface)]',
            FOCUS_RING,
          )}
        >
          <Icon name="plus-square" /> Insert <Icon name="chevron-down" className="text-[10px] text-[var(--color-muted)]" />
        </button>
      </Tooltip>
      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)}>
          <MenuPanel label="Insert" className="w-60 p-1.5">
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className="py-1">
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                  {group.label}
                </p>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    role="menuitem"
                    onClick={() => {
                      setAnchor(null);
                      onPick(item.id);
                    }}
                    className={MENU_ITEM}
                  >
                    <Icon name={item.icon} className="text-[var(--color-muted)]" />
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </MenuPanel>
        </Popover>
      )}
    </>
  );
}

// --- the tool in use ----------------------------------------------------------

/** Says what the active tool is waiting for, and how to stop it. The same bar for every tool. */
function ToolHint({
  tool,
  onShape,
  onDone,
}: {
  tool: Exclude<Tool, { kind: 'select' }>;
  onShape: (shape: ShapeKind) => void;
  onDone: () => void;
}) {
  const message =
    tool.kind === 'place'
      ? `Click where the ${tool.label} should go.`
      : tool.kind === 'shape'
        ? `Drag to draw a ${tool.shape}, or click for one of the usual size.`
        : 'Drag from one item to another, or click one and then the other.';
  const hint = tool.kind === 'connector' ? 'Esc to finish' : 'Shift keeps the tool on · Esc to cancel';
  return (
    // Kept clear of the zoom controls in the bottom-right corner.
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center pl-4 pr-44">
      <div role="status" className={FLOATING_BAR}>
        <Icon name="cursor" className="ml-1 text-[var(--color-accent)]" />
        {tool.kind === 'shape' &&
          SHAPE_KINDS.map((kind) => (
            <Chip key={kind} label={kind} active={tool.shape === kind} onClick={() => onShape(kind)}>
              <Icon name={SHAPE_ICONS[kind]} />
            </Chip>
          ))}
        <span className="px-1">{message}</span>
        <span className="hidden text-[var(--color-muted)] sm:inline">{hint}</span>
        <Button variant="subtle" className="text-xs" onClick={onDone}>
          {tool.kind === 'place' ? 'Cancel' : 'Done'}
        </Button>
      </div>
    </div>
  );
}

// --- zoom -------------------------------------------------------------------

function ZoomControls({
  scale,
  hasSelection,
  onZoom,
  onFit,
  onFitSelection,
}: {
  scale: number;
  hasSelection: boolean;
  onZoom: (scale: number) => void;
  onFit: () => void;
  onFitSelection: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const choose = (fn: () => void) => () => {
    setAnchor(null);
    fn();
  };
  const option = cx(MENU_ITEM, 'justify-between gap-4');
  return (
    <div className="pointer-events-none absolute bottom-4 right-4">
      <div role="group" aria-label="Zoom" className={cx(FLOATING_BAR, 'gap-0.5 px-1 py-1')}>
        <ToolButton label="Zoom out" shortcut={`${MOD}−`} onClick={() => onZoom(scale / 1.25)} compact>
          <Icon name="dash-lg" />
        </ToolButton>
        <Tooltip label="Zoom options">
          <button
            onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={anchor !== null}
            aria-label={`Zoom ${Math.round(scale * 100)}%, zoom options`}
            className={cx('h-8 min-w-14 rounded-md px-1.5 text-xs tabular-nums hover:bg-[var(--color-surface)]', FOCUS_RING)}
          >
            {Math.round(scale * 100)}%
          </button>
        </Tooltip>
        <ToolButton label="Zoom in" shortcut={`${MOD}+`} onClick={() => onZoom(scale * 1.25)} compact>
          <Icon name="plus-lg" />
        </ToolButton>
      </div>
      {anchor && (
        <Popover anchor={anchor} placement="above" onClose={() => setAnchor(null)}>
          <MenuPanel label="Zoom options" className="w-52 p-1.5">
            <button role="menuitem" className={option} onClick={choose(onFit)}>
              Zoom to fit <kbd className="text-xs text-[var(--color-muted)]">⇧1</kbd>
            </button>
            <button role="menuitem" className={option} disabled={!hasSelection} onClick={choose(onFitSelection)}>
              Zoom to selection <kbd className="text-xs text-[var(--color-muted)]">⇧2</kbd>
            </button>
            <div className="my-1 h-px bg-[var(--color-line)]" />
            {[0.5, 1, 2].map((level) => (
              <button key={level} role="menuitem" className={option} onClick={choose(() => onZoom(level))}>
                {level * 100}%
                {level === 1 && <kbd className="text-xs text-[var(--color-muted)]">{MOD}0</kbd>}
              </button>
            ))}
          </MenuPanel>
        </Popover>
      )}
    </div>
  );
}

// --- the selection ----------------------------------------------------------

const LINE_SHAPES: { id: ConnectorShape; label: string; icon: IconName }[] = [
  { id: 'straight', label: 'Straight', icon: 'slash-lg' },
  { id: 'curved', label: 'Curved', icon: 'bezier2' },
  { id: 'elbow', label: 'Right angles', icon: 'arrow-90deg-right' },
];

const DASHES: { id: ConnectorDash; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
];

/** Bootstrap Icons has no dashed-line glyphs, so each style draws a sample of itself. */
const LineSample = ({ dash }: { dash: ConnectorDash }) => (
  <span aria-hidden className="block w-5 border-t-2 border-current" style={{ borderTopStyle: dash }} />
);

/** The value every element shares, or undefined when they differ. */
function shared<T, V>(items: T[], read: (item: T) => V): V | undefined {
  if (items.length === 0) return undefined;
  const first = read(items[0]);
  return items.every((item) => read(item) === first) ? first : undefined;
}

type Patches = { id: string; patch: Partial<CanvasElement> }[];

/**
 * Controls for whatever is selected. Styling applies to every selected element
 * it fits — six notes can be recoloured at once — and a mixed selection shows
 * a section for each kind in it.
 */
function SelectionBar({
  selected,
  frames,
  onUpdateMany,
  onAddChild,
  onDuplicate,
  onGroup,
  onUngroup,
  onDelete,
  onBringToFront,
  onSendToBack,
  onPresentFrom,
}: {
  selected: CanvasElement[];
  frames: FrameElement[];
  onUpdateMany: (updates: Patches) => void;
  onAddChild: (parentId: string) => void;
  onDuplicate: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDelete: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onPresentFrom: (frameId: string) => void;
}) {
  const notes = selected.filter((el): el is NoteElement => el.type === 'note');
  const nodes = selected.filter((el): el is MindNodeElement => el.type === 'node');
  const shapes = selected.filter((el): el is ShapeElement => el.type === 'shape');
  const connectors = selected.filter((el): el is ConnectorElement => el.type === 'connector');
  const boxes = selected.filter((el) => el.type !== 'connector');
  const frame = selected.length === 1 && selected[0].type === 'frame' ? (selected[0] as FrameElement) : null;
  // Grouping makes sense for two or more things not already one group; any
  // grouped member in the selection can be ungrouped.
  const groupIds = new Set(boxes.map((el) => el.groupId));
  const isOneGroup = boxes.length > 1 && groupIds.size === 1 && !groupIds.has(undefined);
  const canGroup = boxes.length >= 2 && !isOneGroup;
  const canUngroup = boxes.some((el) => el.groupId);

  const set = <T extends CanvasElement>(targets: T[], patch: Partial<T>) =>
    onUpdateMany(targets.map((el) => ({ id: el.id, patch: patch as Partial<CanvasElement> })));

  const sections: React.ReactNode[] = [];

  if (notes.length) {
    sections.push(
      <SwatchGroup
        key="note"
        label="Note colour"
        colors={NOTE_COLORS}
        value={shared(notes, (n) => n.color ?? NOTE_COLORS[0])}
        onPick={(color) => set(notes, { color })}
      />,
    );
  }

  if (nodes.length) {
    sections.push(
      <span key="node" className="flex items-center gap-1.5">
        <SwatchGroup
          label="Branch colour"
          colors={NODE_COLORS}
          value={shared(nodes, (n) => n.color ?? NODE_COLORS[0])}
          onPick={(color) => set(nodes, { color })}
        />
        {nodes.length === 1 && (
          <Tooltip label="Add a child node (Tab)">
            <Button variant="subtle" className="text-xs" onClick={() => onAddChild(nodes[0].id)}>
              <Icon name="plus-lg" /> Child
            </Button>
          </Tooltip>
        )}
      </span>,
    );
  }

  if (shapes.length) {
    const strokeWidth = shared(shapes, (s) => s.strokeWidth ?? 2);
    sections.push(
      <span key="shape" className="flex flex-wrap items-center gap-1.5">
        <span role="group" aria-label="Shape" className="flex items-center gap-1">
          {SHAPE_KINDS.map((kind) => (
            <Chip key={kind} label={kind} active={shared(shapes, (s) => s.shape) === kind} onClick={() => set(shapes, { shape: kind })}>
              <Icon name={SHAPE_ICONS[kind]} />
            </Chip>
          ))}
        </span>
        <SwatchGroup
          label="Fill"
          colors={SHAPE_FILLS}
          square
          value={shared(shapes, (s) => s.fill ?? 'transparent')}
          onPick={(fill) => set(shapes, { fill })}
        />
        <span role="group" aria-label="Edge style" className="flex items-center gap-1">
          {DASHES.map((dash) => (
            <Chip
              key={dash.id}
              label={`${dash.label} edge`}
              active={shared(shapes, (s) => s.dash ?? 'solid') === dash.id}
              onClick={() => set(shapes, { dash: dash.id })}
            >
              <LineSample dash={dash.id} />
            </Chip>
          ))}
        </span>
        <SwatchGroup
          label="Edge colour"
          colors={CONNECTOR_COLORS}
          value={shared(shapes, (s) => s.stroke ?? CONNECTOR_COLORS[0])}
          onPick={(stroke) => set(shapes, { stroke })}
        />
        <Tooltip label="Edge thickness">
          <select
            aria-label="Edge thickness"
            value={strokeWidth ?? ''}
            onChange={(e) => set(shapes, { strokeWidth: Number(e.target.value) })}
            className={cx('h-8 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2', FOCUS_RING)}
          >
            {strokeWidth === undefined && <option value="">Mixed</option>}
            {[1, 2, 3, 5, 8].map((width) => (
              <option key={width} value={width}>
                {width}px
              </option>
            ))}
          </select>
        </Tooltip>
      </span>,
    );
  }

  if (connectors.length) {
    const arrowEnd = shared(connectors, (c) => c.arrowEnd ?? c.arrow ?? true);
    const arrowStart = shared(connectors, (c) => c.arrowStart ?? false);
    const routed = connectors.some((c) => c.midX !== undefined || c.midY !== undefined || c.bend);
    sections.push(
      <span key="connector" className="flex flex-wrap items-center gap-1.5">
        <span role="group" aria-label="Line shape" className="flex items-center gap-1">
          {LINE_SHAPES.map((shape) => (
            <Chip
              key={shape.id}
              label={shape.label}
              active={shared(connectors, (c) => c.shape ?? 'straight') === shape.id}
              onClick={() => set(connectors, { shape: shape.id })}
            >
              <Icon name={shape.icon} />
            </Chip>
          ))}
        </span>
        <span role="group" aria-label="Arrowheads" className="flex items-center gap-1">
          <Chip label="Arrow at start" active={arrowStart === true} onClick={() => set(connectors, { arrowStart: !arrowStart })}>
            <Icon name="arrow-left" />
          </Chip>
          <Chip label="Arrow at end" active={arrowEnd === true} onClick={() => set(connectors, { arrowEnd: !arrowEnd })}>
            <Icon name="arrow-right" />
          </Chip>
        </span>
        <span role="group" aria-label="Line style" className="flex items-center gap-1">
          {DASHES.map((dash) => (
            <Chip
              key={dash.id}
              label={dash.label}
              active={shared(connectors, (c) => c.dash ?? 'solid') === dash.id}
              onClick={() => set(connectors, { dash: dash.id })}
            >
              <LineSample dash={dash.id} />
            </Chip>
          ))}
        </span>
        <SwatchGroup
          label="Line colour"
          colors={CONNECTOR_COLORS}
          value={shared(connectors, (c) => c.color ?? CONNECTOR_COLORS[0])}
          onPick={(color) => set(connectors, { color })}
        />
        {routed && (
          <Tooltip label="Discard manual routing and let the line find its own way">
            <Button
              variant="subtle"
              className="text-xs"
              onClick={() => set(connectors, { midX: undefined, midY: undefined, bend: undefined })}
            >
              Reset route
            </Button>
          </Tooltip>
        )}
        {connectors.length === 1 && (
          // Keyed so a label still being saved lands on its own connector, not the next one selected.
          <ConnectorLabel key={connectors[0].id} connector={connectors[0]} onChange={(label) => set(connectors, { label })} />
        )}
      </span>,
    );
  }

  if (frame) {
    sections.push(
      <FrameControls
        key={`frame-${frame.id}`}
        frame={frame}
        frames={frames}
        onUpdateMany={onUpdateMany}
        onPresent={() => onPresentFrom(frame.id)}
      />,
    );
  }

  sections.push(
    <span key="arrange" className="flex items-center gap-1">
      {boxes.length >= 2 && <AlignMenu boxes={boxes} onUpdateMany={onUpdateMany} />}
      {boxes.length > 0 && (
        <>
          <ToolButton label="Bring to front" onClick={onBringToFront} compact>
            <Icon name="front" />
          </ToolButton>
          <ToolButton label="Send to back" onClick={onSendToBack} compact>
            <Icon name="back" />
          </ToolButton>
        </>
      )}
      {canGroup && (
        <ToolButton label="Group" shortcut={`${MOD}G`} onClick={onGroup} compact>
          <Icon name="bounding-box" />
        </ToolButton>
      )}
      {canUngroup && (
        <ToolButton label="Ungroup" shortcut={IS_MAC ? '⇧⌘G' : 'Ctrl+Shift+G'} onClick={onUngroup} compact>
          <Icon name="bounding-box-circles" />
        </ToolButton>
      )}
      <ToolButton label="Duplicate" shortcut={`${MOD}D`} onClick={onDuplicate} compact>
        <Icon name="copy" />
      </ToolButton>
      <ToolButton label="Delete" shortcut="Del" onClick={onDelete} compact>
        <Icon name="trash3" />
      </ToolButton>
    </span>,
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
      <div role="toolbar" aria-label="Selection" className={cx(FLOATING_BAR, 'max-w-full')}>
        {selected.length > 1 && (
          <span className="px-1 text-[var(--color-muted)]">
            {isOneGroup && boxes.length === selected.length ? `Group of ${selected.length}` : `${selected.length} selected`}
          </span>
        )}
        {sections.map((section, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <Divider />}
            {section}
          </span>
        ))}
      </div>
    </div>
  );
}

function ConnectorLabel({ connector, onChange }: { connector: ConnectorElement; onChange: (label: string) => void }) {
  const [draft, setDraft] = useState(connector.label ?? '');
  const save = useAutosave<string>(onChange, 400);
  return (
    <input
      value={draft}
      aria-label="Connector label"
      onChange={(e) => {
        setDraft(e.target.value);
        save.schedule(e.target.value);
      }}
      onBlur={save.flush}
      placeholder="Label"
      className="w-32 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
    />
  );
}

/**
 * A frame's name and its place in the running order. The name is saved once
 * typing pauses, not per keystroke, so collaborators are not sent every letter
 * and an undo takes back the name rather than its last character.
 */
function FrameControls({
  frame,
  frames,
  onUpdateMany,
  onPresent,
}: {
  frame: FrameElement;
  frames: FrameElement[];
  onUpdateMany: (updates: Patches) => void;
  onPresent: () => void;
}) {
  const [name, setName] = useState(frame.name);
  const focused = useRef(false);
  const save = useAutosave<string>((value) => onUpdateMany([{ id: frame.id, patch: { name: value } as Partial<CanvasElement> }]), 500);
  useEffect(() => {
    if (!focused.current) setName(frame.name);
  }, [frame.name]);

  const index = frames.findIndex((f) => f.id === frame.id);
  /** Moves the frame one place and renumbers every frame, which also mends any duplicate numbers. */
  function move(step: number) {
    const order = [...frames];
    const to = index + step;
    if (to < 0 || to >= order.length) return;
    [order[index], order[to]] = [order[to], order[index]];
    onUpdateMany(order.map((f, i) => ({ id: f.id, patch: { order: i } as Partial<CanvasElement> })));
  }

  return (
    <span className="flex items-center gap-1.5">
      <input
        value={name}
        aria-label="Frame name"
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setName(e.target.value);
          save.schedule(e.target.value);
        }}
        onBlur={() => {
          focused.current = false;
          save.flush();
        }}
        className="w-36 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
      />
      <ToolButton label="Move earlier in the slides" onClick={() => move(-1)} disabled={index <= 0} compact>
        <Icon name="chevron-left" />
      </ToolButton>
      <span className="tabular-nums text-[var(--color-muted)]">
        Slide {index + 1} of {frames.length}
      </span>
      <ToolButton label="Move later in the slides" onClick={() => move(1)} disabled={index >= frames.length - 1} compact>
        <Icon name="chevron-right" />
      </ToolButton>
      <Button variant="subtle" className="text-xs" onClick={onPresent}>
        Present from here
      </Button>
    </span>
  );
}

function AlignMenu({ boxes, onUpdateMany }: { boxes: CanvasElement[]; onUpdateMany: (updates: Patches) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const aligns: { id: Alignment; label: string; icon: IconName }[] = [
    { id: 'left', label: 'Align left edges', icon: 'align-start' },
    { id: 'centerX', label: 'Align centres across', icon: 'align-center' },
    { id: 'right', label: 'Align right edges', icon: 'align-end' },
    { id: 'top', label: 'Align top edges', icon: 'align-top' },
    { id: 'centerY', label: 'Align middles', icon: 'align-middle' },
    { id: 'bottom', label: 'Align bottom edges', icon: 'align-bottom' },
  ];
  const run = (updates: Patches) => {
    setAnchor(null);
    if (updates.length) onUpdateMany(updates);
  };
  const item = MENU_ITEM;
  return (
    <>
      <Tooltip label="Align and distribute">
        <button
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-label="Align and distribute"
          className={cx('grid h-8 w-8 place-items-center rounded-md hover:bg-[var(--color-surface)]', FOCUS_RING)}
        >
          <Icon name="distribute-vertical" />
        </button>
      </Tooltip>
      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)}>
          <MenuPanel label="Align and distribute" className="w-56 p-1.5">
            {aligns.map((align) => (
              <button key={align.id} role="menuitem" className={item} onClick={() => run(alignBoxes(boxes, align.id))}>
                <Icon name={align.icon} className="text-[var(--color-muted)]" /> {align.label}
              </button>
            ))}
            <div className="my-1 h-px bg-[var(--color-line)]" />
            <button role="menuitem" className={item} disabled={boxes.length < 3} onClick={() => run(distributeBoxes(boxes, 'x'))}>
              <Icon name="distribute-horizontal" className="text-[var(--color-muted)]" /> Space evenly across
            </button>
            <button role="menuitem" className={item} disabled={boxes.length < 3} onClick={() => run(distributeBoxes(boxes, 'y'))}>
              <Icon name="distribute-vertical" className="text-[var(--color-muted)]" /> Space evenly down
            </button>
          </MenuPanel>
        </Popover>
      )}
    </>
  );
}

/**
 * A row of colour choices. Each is named, so it can be told apart without
 * seeing it, and the chosen one is marked as pressed.
 */
function SwatchGroup({
  label,
  colors,
  value,
  onPick,
  square,
}: {
  label: string;
  colors: string[];
  /** The colour every selected element shares; none is marked when they differ. */
  value: string | undefined;
  onPick: (color: string) => void;
  square?: boolean;
}) {
  return (
    <span role="group" aria-label={label} className="flex items-center gap-1">
      {colors.map((color) => {
        const name = `${label}: ${colorName(color)}`;
        return (
          <Tooltip key={color} label={name}>
            <button
              aria-label={name}
              aria-pressed={value === color}
              onClick={() => onPick(color)}
              className={cx(
                'h-7 w-7 border-2',
                square ? 'rounded-md' : 'rounded-full',
                value === color ? 'border-[var(--color-ink)]' : square ? 'border-[var(--color-line)]' : 'border-transparent',
                FOCUS_RING,
              )}
              style={
                color === 'transparent'
                  ? {
                      // A diagonal bar is the usual way to show "no fill".
                      backgroundImage:
                        'linear-gradient(45deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)',
                    }
                  : { background: color }
              }
            />
          </Tooltip>
        );
      })}
    </span>
  );
}

function Chip({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cx(
          'grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm capitalize transition-colors',
          active
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-surface)] hover:bg-[var(--color-line)]',
          FOCUS_RING,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * An icon button with a short name and, where there is one, its key. On a
 * touch screen, where there is no hover to show a tooltip, the name is printed
 * under the icon instead.
 */
function ToolButton({
  label,
  shortcut,
  children,
  onClick,
  active,
  disabled,
  compact,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Smaller, and with no printed name: for the floating bars. */
  compact?: boolean;
}) {
  return (
    <Tooltip label={shortcut ? `${label} (${shortcut})` : label}>
      <button
        aria-label={label}
        aria-keyshortcuts={shortcut && shortcut.length === 1 ? shortcut : undefined}
        aria-pressed={active}
        onClick={onClick}
        disabled={disabled}
        className={cx(
          'grid place-items-center rounded-md transition-colors disabled:opacity-40',
          compact ? 'h-8 w-8 text-sm' : 'min-h-9 min-w-9 px-1 text-base',
          active
            ? 'bg-[var(--color-accent)] text-white'
            : 'hover:bg-[var(--color-surface)] text-[var(--color-ink)]',
          FOCUS_RING,
        )}
      >
        {children}
        {!compact && (
          <span aria-hidden className="hidden text-[10px] leading-tight [@media(hover:none)]:block">
            {label}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

const ACCEPT: Record<string, string> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
};

function InsertDialog({
  kind,
  workspaceId,
  onInsert,
  onCancel,
  onUpload,
}: {
  kind: 'embed' | 'image' | 'audio' | 'video' | 'link';
  workspaceId: string;
  onInsert: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  onUpload: (file: File) => void;
}) {
  const [url, setUrl] = useState('');
  const [documentId, setDocumentId] = useState('');

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]';

  const titles: Record<typeof kind, string> = {
    embed: 'Embed a web page or video',
    image: 'Add an image',
    audio: 'Add audio',
    video: 'Add a video',
    link: 'Add a document',
  };

  // Only a web page can be framed. Pictures and media may also be an uploaded
  // file's path, which never runs as a page.
  const notWebPage = kind === 'embed' && Boolean(url.trim()) && !isWebUrl(url.trim());
  const [documents, setDocuments] = useState<{ id: string; title: string }[]>([]);

  function submit(chosenId = documentId) {
    if (kind === 'link') {
      const chosen = documents.find((d) => d.id === chosenId);
      if (!chosen) return;
      onInsert({ documentId: chosen.id, title: chosen.title });
      return;
    }
    if (!url.trim() || notWebPage) return;
    onInsert({ url: url.trim() });
  }

  return (
    <Modal
      title={titles[kind]}
      description={kind === 'embed' ? "Some sites can't be embedded." : undefined}
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            onClick={() => submit()}
            disabled={kind === 'link' ? !documentId : !url.trim() || notWebPage}
          >
            Add to canvas
          </Button>
        </>
      }
    >
      {kind === 'link' ? (
        <DocumentSearch
          workspaceId={workspaceId}
          value={documentId}
          onChange={setDocumentId}
          onChoose={(id) => submit(id)}
          onResults={setDocuments}
        />
      ) : (
        <div className="space-y-2">
          <input
            autoFocus
            className={field}
            value={url}
            aria-label="Web address"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={
              kind === 'embed'
                ? 'https://www.youtube.com/watch?v=…'
                : kind === 'audio'
                  ? 'https://example.com/track.mp3'
                  : kind === 'video'
                    ? 'https://example.com/clip.mp4'
                    : 'https://example.com/image.png'
            }
          />
          {notWebPage && (
            <p className="text-xs text-[var(--color-muted)]">Enter a web address starting with https://</p>
          )}
          {ACCEPT[kind] && (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-muted)] focus-within:border-[var(--color-accent)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
              <input
                type="file"
                accept={ACCEPT[kind]}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(file);
                }}
              />
              Or upload a file from your computer
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Finds a document by typing part of its name. Arrow keys move through the
 * matches and Enter adds the highlighted one.
 */
function DocumentSearch({
  workspaceId,
  value,
  onChange,
  onChoose,
  onResults,
}: {
  workspaceId: string;
  value: string;
  onChange: (id: string) => void;
  onChoose: (id: string) => void;
  onResults: (documents: { id: string; title: string }[]) => void;
}) {
  const [query, setQuery] = useState('');
  // Searched on the server as the title is typed, so any document can be
  // found, not only the most recently touched.
  const typed = useDebounced(query.trim(), 150);
  const documents = useLinkTargets(workspaceId, typed, { kinds: ['documents'], limit: 50 });
  const all = useMemo(() => documents.data?.documents ?? [], [documents.data]);
  useEffect(() => onResults(all), [all, onResults]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? all.filter((d) => (d.title || 'Untitled').toLowerCase().includes(q)) : all).slice(0, 50);
  }, [all, query]);

  // Keep a match highlighted while typing narrows the list.
  useEffect(() => {
    if (matches.length && !matches.some((d) => d.id === value)) onChange(matches[0].id);
    if (!matches.length && value) onChange('');
  }, [matches, value, onChange]);

  function onKey(e: React.KeyboardEvent) {
    const index = matches.findIndex((d) => d.id === value);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = matches[Math.min(matches.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        onChange(next.id);
        document.getElementById(`doc-option-${next.id}`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' && value) {
      e.preventDefault();
      onChoose(value);
    }
  }

  return (
    <div className="space-y-2">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder="Search documents…"
        role="combobox"
        aria-expanded
        aria-controls="canvas-document-results"
        aria-activedescendant={value ? `doc-option-${value}` : undefined}
        aria-label="Search documents"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div
        id="canvas-document-results"
        role="listbox"
        aria-label="Documents"
        className="max-h-64 overflow-y-auto rounded-md border border-[var(--color-line)]"
      >
        {documents.isLoading && <p className="px-2 py-3 text-xs text-[var(--color-muted)]">Loading…</p>}
        {!documents.isLoading && matches.length === 0 && (
          <p className="px-2 py-3 text-xs text-[var(--color-muted)]">No documents match “{query}”.</p>
        )}
        {matches.map((d) => (
          <div
            key={d.id}
            id={`doc-option-${d.id}`}
            role="option"
            aria-selected={d.id === value}
            onClick={() => onChange(d.id)}
            onDoubleClick={() => onChoose(d.id)}
            className={cx(
              'cursor-pointer truncate px-2 py-1.5 text-sm',
              d.id === value ? 'bg-[var(--color-accent)] text-white' : 'hover:bg-[var(--color-surface)]',
            )}
          >
            {d.title || 'Untitled'}
          </div>
        ))}
      </div>
    </div>
  );
}
