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
  type ShapeElement,
  type ShapeKind,
} from '@paradocs/shared';
import type { CollabSession, Peer } from '../../lib/collaboration';
import { boundsOf, useCanvasElements } from '../../lib/canvasStore';
import { peerPointer, usePublishPointer } from '../../lib/canvasPresence';
import { cx, useAutosave } from '../../lib/util';
import { claimNewDocument } from '../../lib/newDocuments';
import { useAllDocuments, useCreateDocument, useMembers, useUploadFile, type DocumentPatch } from '../../api/hooks';
import { useToast } from '../Toast';
import CanvasSurface, { type Viewport } from './CanvasSurface';
import PresentMode from './PresentMode';
import PeerCursors from './PeerCursors';
import { Modal } from '../Modal';
import { Button, Tooltip } from '../ui';
import Avatar from '../Avatar';
import Icon, { type IconName } from '../Icon';
import SheetRefPicker from '../sheet/SheetRefPicker';
import { withCachedSheetValues } from '../../lib/sheetRefs';

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
 * A tool that has been picked and is waiting for a click on the board to say
 * where its element goes. Nothing is created until then, so picking a tool and
 * changing your mind leaves the board — and the workspace — as it was.
 */
interface Placing {
  /** Which toolbar button armed it, so that button shows as on. */
  tool: string;
  type: CanvasElement['type'];
  /** What is being placed, for the hint: "sticky note", "image". */
  label: string;
  place: (point: { x: number; y: number }) => void;
}

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
  const { elements, create, update, updateMany, remove, bringToFront } = useCanvasElements(session.ydoc);
  const createDocument = useCreateDocument(workspaceId);
  const uploadFile = useUploadFile(workspaceId);
  // Who can be tagged on this board, and whose names its tags resolve to.
  const members = useMembers(workspaceId);
  const toast = useToast();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const publishPointer = usePublishPointer(session);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The connector tool is a mode, not a one-shot action: it stays on so several
  // connections can be drawn in a row.
  const [connectorTool, setConnectorTool] = useState(false);
  // The shape tool is a mode too: pick a kind, then drag out its bounds.
  const [shapeTool, setShapeTool] = useState<ShapeKind | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  // Set briefly so a node created by the + button opens for typing.
  const [editRequestId, setEditRequestId] = useState<string | null>(null);
  const [inserting, setInserting] = useState<Inserting>(null);
  const [sheetInserting, setSheetInserting] = useState<'cell' | 'chart' | null>(null);

  /**
   * Copying with elements selected, and no text selected, copies what they say
   * — with each spreadsheet cell as the value it shows and each chart as its
   * numbers — so a board's figures paste as figures rather than as nothing.
   */
  useEffect(() => {
    function onCopy(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const chosen = elements.filter((element) => selectedIds.has(element.id));
      if (chosen.length === 0 || !event.clipboardData) return;
      const names = new Map((members.data ?? []).map((member) => [member.userId, member.name]));
      const text = withCachedSheetValues(canvasSearchText(chosen, names)).trim();
      if (!text) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [elements, selectedIds, members.data]);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [title, setTitle] = useState(doc.title);

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

  /** Creates an element centred on the point the board was clicked at. */
  const addElement = useCallback(
    (type: CanvasElement['type'], point: { x: number; y: number }, extra: Partial<CanvasElement> = {}) => {
      const size = DEFAULT_SIZE[type];
      const id = create(type, {
        x: point.x - size.width / 2,
        y: point.y - size.height / 2,
        ...extra,
      } as never);
      setSelectedIds(new Set([id]));
      if (TEXT_ELEMENTS.has(type)) setEditRequestId(id);
      return id;
    },
    [create],
  );

  /** Arms a tool so the next click on the board places its element. */
  function startPlacing(next: Placing) {
    setShapeTool(null);
    setConnectorTool(false);
    setPlacing(next);
  }

  /** A toolbar button that places an element directly: press to arm, press again to put it away. */
  function placeTool(tool: string, type: CanvasElement['type'], label: string, extra: () => Partial<CanvasElement> = () => ({})) {
    if (placing?.tool === tool) {
      setPlacing(null);
      return;
    }
    startPlacing({ tool, type, label, place: (point) => addElement(type, point, extra()) });
  }

  /** A toolbar button whose element needs choosing first: the dialog opens, then the click places it. */
  function openInsert(type: NonNullable<Inserting>['type']) {
    if (placing?.tool === type) {
      setPlacing(null);
      return;
    }
    setPlacing(null);
    setInserting({ type });
  }

  /**
   * Creates a real document in the workspace and places a card for it, so a
   * board can spawn the documents it references without leaving the canvas.
   * The document is only made once the card has somewhere to go.
   */
  async function createDocumentCard(point: { x: number; y: number }) {
    try {
      const doc = await createDocument.mutateAsync({ title: 'Untitled', folderId: null });
      addElement('link', point, { documentId: doc.id, title: doc.title } as Partial<CanvasElement>);
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

  /** Uploads dropped or pasted files and lays them out from the drop point. */
  async function handleFiles(files: File[], point: { x: number; y: number }) {
    if (!canEdit) return;
    let offset = 0;
    const created: string[] = [];
    for (const file of files) {
      const type = elementTypeFor(file);
      if (!type) {
        toast(`${file.name} is not an image, audio or video file`, 'error');
        continue;
      }
      try {
        // Attribute the file to this canvas so it is not listed as orphaned.
        const uploaded = await uploadFile.mutateAsync({ file, documentId: doc.id });
        const size = DEFAULT_SIZE[type];
        created.push(
          create(type, {
            x: point.x - size.width / 2 + offset,
            y: point.y - size.height / 2 + offset,
            url: uploaded.url,
            title: file.name,
            alt: file.name,
          } as never),
        );
        offset += 28;
      } catch (err) {
        toast(err instanceof Error ? err.message : `Could not upload ${file.name}`, 'error');
      }
    }
    // Select what landed, so its style bar and resize handle are available.
    if (created.length) setSelectedIds(new Set(created));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShapeTool(null);
        setConnectorTool(false);
        setPlacing(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Adds a child under any node, at any depth. New children stack below their
   * existing siblings so a branch grows downward without overlapping.
   */
  function addChild(parentId: string) {
    const parent = elements.find((el) => el.id === parentId);
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
    setEditRequestId(id);
  }

  function deleteSelection() {
    if (selectedIds.size === 0) return;
    remove([...selectedIds]);
    setSelectedIds(new Set());
  }

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
    const rect = document.getElementById('paradocs-canvas')?.getBoundingClientRect();
    if (!point || !rect) return;
    setViewport((current) => ({
      ...current,
      x: rect.width / 2 - point.x * current.scale,
      y: rect.height / 2 - point.y * current.scale,
    }));
  }

  function zoomToFit() {
    const bounds = boundsOf(elements);
    const rect = document.getElementById('paradocs-canvas')?.getBoundingClientRect();
    if (!bounds || !rect) return;
    const scale = Math.min(3, Math.max(0.1, Math.min(
      (rect.width - 80) / bounds.width,
      (rect.height - 80) / bounds.height,
    )));
    setViewport({
      scale,
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
    });
  }

  const selectedFrame = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    return el?.type === 'frame' ? el : null;
  }, [selectedIds, elements]);

  const selectedConnector = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    return el?.type === 'connector' ? (el as ConnectorElement) : null;
  }, [selectedIds, elements]);

  const selectedShape = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    return el?.type === 'shape' ? (el as ShapeElement) : null;
  }, [selectedIds, elements]);

  const selectedNode = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    return el?.type === 'node' ? (el as MindNodeElement) : null;
  }, [selectedIds, elements]);

  const selectedNote = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    return el?.type === 'note' ? el : null;
  }, [selectedIds, elements]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-line)] px-3 py-2">
        <input
          ref={titleRef}
          value={title}
          readOnly={!canEdit}
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
            <ToolButton
              label="Sticky note — click the board to place it, or double-click the board"
              active={placing?.tool === 'note'}
              onClick={() => placeTool('note', 'note', 'sticky note', () => ({ text: '', color: NOTE_COLORS[0] }) as Partial<CanvasElement>)}
            >
              <Icon name="sticky" />
            </ToolButton>
            <ToolButton
              label="Text label — click the board to place it"
              active={placing?.tool === 'text'}
              onClick={() => placeTool('text', 'text', 'text label', () => ({ text: '' }) as Partial<CanvasElement>)}
            >
              <Icon name="fonts" />
            </ToolButton>
            <ToolButton
              label="Create a document — click the board to place its card"
              active={placing?.tool === 'newDocument'}
              onClick={() =>
                placing?.tool === 'newDocument'
                  ? setPlacing(null)
                  : startPlacing({ tool: 'newDocument', type: 'link', label: 'new document', place: (point) => void createDocumentCard(point) })
              }
            >
              <Icon name="file-earmark-plus" />
            </ToolButton>
            <ToolButton label="Place an existing document on the board" active={placing?.tool === 'link'} onClick={() => openInsert('link')}>
              <Icon name="file-earmark-text" />
            </ToolButton>
            <ToolButton label="Embed a webpage or video by URL" active={placing?.tool === 'embed'} onClick={() => openInsert('embed')}>
              <Icon name="play-btn" />
            </ToolButton>
            <ToolButton label="Image — by URL, upload, paste or drop" active={placing?.tool === 'image'} onClick={() => openInsert('image')}>
              <Icon name="image" />
            </ToolButton>
            <ToolButton label="Audio — by URL or upload" active={placing?.tool === 'audio'} onClick={() => openInsert('audio')}>
              <Icon name="music-note-beamed" />
            </ToolButton>
            <ToolButton label="Video — by URL or upload" active={placing?.tool === 'video'} onClick={() => openInsert('video')}>
              <Icon name="film" />
            </ToolButton>
            <ToolButton
              label="Spreadsheet cell — shows its current value"
              active={placing?.tool === 'sheetCell'}
              onClick={() => (placing?.tool === 'sheetCell' ? setPlacing(null) : (setPlacing(null), setSheetInserting('cell')))}
            >
              <Icon name="table" />
            </ToolButton>
            <ToolButton
              label="Spreadsheet chart — drawn from the spreadsheet's current data"
              active={placing?.tool === 'sheetChart'}
              onClick={() => (placing?.tool === 'sheetChart' ? setPlacing(null) : (setPlacing(null), setSheetInserting('chart')))}
            >
              <Icon name="bar-chart" />
            </ToolButton>
            <ToolButton
              label="Mind map — click the board to place a root node you can branch from"
              active={placing?.tool === 'node'}
              onClick={() => placeTool('node', 'node', 'mind map', () => ({ text: '', color: NODE_COLORS[0] }) as Partial<CanvasElement>)}
            >
              <Icon name="diagram-3" />
            </ToolButton>
            <ToolButton
              label={
                shapeTool
                  ? 'Shape tool on — drag on the board to draw (esc to turn off)'
                  : 'Shape tool — drag on the board to draw a shape'
              }
              active={Boolean(shapeTool)}
              onClick={() => {
                setShapeTool(shapeTool ? null : 'rectangle');
                setConnectorTool(false);
                setPlacing(null);
              }}
            >
              <Icon name="square" />
            </ToolButton>
            <ToolButton
              label="Frame (presentation slide) — click the board to place it"
              active={placing?.tool === 'frame'}
              onClick={() =>
                placeTool('frame', 'frame', 'frame', () => ({ name: `Frame ${frames.length + 1}`, order: frames.length }) as Partial<CanvasElement>)
              }
            >
              <Icon name="aspect-ratio" />
            </ToolButton>
            <Divider />
            <ToolButton
              label={
                connectorTool
                  ? 'Connector tool on — click a port then click the target, or drag between them (esc cancels)'
                  : 'Connector tool — click or drag from an element to connect'
              }
              active={connectorTool}
              onClick={() => {
                setConnectorTool((on) => !on);
                setShapeTool(null);
                setPlacing(null);
              }}
            >
              <Icon name="arrow-left-right" />
            </ToolButton>
            <ToolButton label="Delete selection (or press Delete)" disabled={selectedIds.size === 0} onClick={deleteSelection}>
              <Icon name="trash3" />
            </ToolButton>
          </>
        )}

        {selectedNode && canEdit && (
          <>
            <Divider />
            {NODE_COLORS.map((color) => (
              <Tooltip key={color} label="Branch colour">
                <button
                  aria-label="Branch colour"
                  onClick={() => update(selectedNode.id, { color } as Partial<CanvasElement>)}
                  className={cx(
                    'h-7 w-7 rounded-full border-2',
                    (selectedNode.color ?? NODE_COLORS[0]) === color
                      ? 'border-[var(--color-ink)]'
                      : 'border-transparent',
                  )}
                  style={{ background: color }}
                />
              </Tooltip>
            ))}
            <Tooltip label="Add a child node">
              <Button variant="subtle" className="text-xs" onClick={() => addChild(selectedNode.id)}>
                <Icon name="plus-lg" /> Child
              </Button>
            </Tooltip>
          </>
        )}

        {selectedNote && canEdit && (
          <>
            <Divider />
            {NOTE_COLORS.map((color) => (
              <Tooltip key={color} label="Note colour">
                <button
                  aria-label="Note colour"
                  onClick={() => update(selectedNote.id, { color } as Partial<CanvasElement>)}
                  className={cx(
                    'h-7 w-7 rounded-full border-2',
                    selectedNote.color === color ? 'border-[var(--color-ink)]' : 'border-transparent',
                  )}
                  style={{ background: color }}
                />
              </Tooltip>
            ))}
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
                    className="rounded-full"
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
          <span className="tabular-nums text-xs text-[var(--color-muted)]">
            {elements.length} item{elements.length === 1 ? '' : 's'} · {Math.round(viewport.scale * 100)}%
          </span>
          <ToolButton label="Zoom to fit everything on the board" onClick={zoomToFit}>
            <Icon name="arrows-fullscreen" />
          </ToolButton>
          <Tooltip label="Present the frames as slides">
            <Button variant="subtle" className="text-sm" onClick={() => setPresenting(0)}>
              <Icon name="play-fill" /> Present
            </Button>
          </Tooltip>
        </div>
      </div>

      {selectedConnector && canEdit && (
        <ConnectorBar
          connector={selectedConnector}
          onChange={(patch) => update(selectedConnector.id, patch as Partial<CanvasElement>)}
        />
      )}

      {shapeTool && canEdit && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-1.5 text-xs">
          <span className="text-[var(--color-muted)]">Draw</span>
          {SHAPE_KINDS.map((kind) => (
            <Chip key={kind} label={kind} active={shapeTool === kind} onClick={() => setShapeTool(kind)}>
              <Icon name={SHAPE_ICONS[kind]} />
            </Chip>
          ))}
          <span className="text-[var(--color-muted)]">
            Drag on the board to draw, or click for a default size. Double-click a shape to write in it.
          </span>
          <Button variant="subtle" className="ml-auto text-xs" onClick={() => setShapeTool(null)}>
            Done
          </Button>
        </div>
      )}

      {placing && canEdit && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-1.5 text-xs">
          <Icon name="cursor" className="text-[var(--color-accent)]" />
          <span>
            Click on the board where the {placing.label} should go.
          </span>
          <span className="text-[var(--color-muted)]">Esc to cancel.</span>
          <Button variant="subtle" className="ml-auto text-xs" onClick={() => setPlacing(null)}>
            Cancel
          </Button>
        </div>
      )}

      {selectedShape && canEdit && (
        <ShapeBar
          shape={selectedShape}
          onChange={(patch) => update(selectedShape.id, patch as Partial<CanvasElement>)}
        />
      )}

      {selectedFrame && canEdit && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-1.5 text-xs">
          <span className="text-[var(--color-muted)]">Frame name</span>
          <input
            value={selectedFrame.name}
            onChange={(e) => update(selectedFrame.id, { name: e.target.value } as Partial<CanvasElement>)}
            className="min-w-0 flex-1 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-[var(--color-muted)]">Slide</span>
          <input
            type="number"
            min={1}
            value={(selectedFrame.order ?? 0) + 1}
            onChange={(e) =>
              update(selectedFrame.id, { order: Math.max(0, Number(e.target.value) - 1) } as Partial<CanvasElement>)
            }
            className="w-16 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
          />
          <Button
            variant="subtle"
            className="text-xs"
            onClick={() => setPresenting(frames.findIndex((f) => f.id === selectedFrame.id))}
          >
            Present from here
          </Button>
        </div>
      )}

      <div id="paradocs-canvas" className="relative min-h-0 flex-1">
        <CanvasSurface
          elements={elements}
          viewport={viewport}
          onViewportChange={setViewport}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          editable={canEdit}
          members={members.data ?? []}
          connectorTool={connectorTool}
          shapeTool={shapeTool}
          placing={placing ? DEFAULT_SIZE[placing.type] : null}
          onPlace={(point) => {
            const current = placing;
            // One element per pick: the tool puts itself away once used.
            setPlacing(null);
            current?.place(point);
          }}
          onDrawShape={(rect) => {
            const id = create('shape', {
              ...rect,
              shape: shapeTool ?? 'rectangle',
              text: '',
              fill: SHAPE_FILLS[1],
              stroke: CONNECTOR_COLORS[1],
              strokeWidth: 2,
              dash: 'solid',
            } as never);
            setSelectedIds(new Set([id]));
            // The shape has been drawn, so the tool has done its job; leaving
            // it armed would turn the next click meant for the label into
            // another shape.
            setShapeTool(null);
            setEditRequestId(id);
          }}
          onConnect={completeConnection}
          onUpdate={update}
          onCommit={updateMany}
          onBringToFront={bringToFront}
          onOpenDocument={onOpenDocument}
          dark={dark}
          onDeleteSelection={deleteSelection}
          onFiles={handleFiles}
          onPointer={publishPointer}
          onAddChild={addChild}
          editRequestId={editRequestId}
          onCreateNoteAt={(point) => {
            const size = DEFAULT_SIZE.note;
            const id = create('note', {
              x: point.x - size.width / 2,
              y: point.y - size.height / 2,
              text: '',
              color: NOTE_COLORS[0],
            } as never);
            setSelectedIds(new Set([id]));
            setEditRequestId(id);
          }}
        />

        <PeerCursors session={session} viewport={viewport} />

        {elements.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center text-sm text-[var(--color-muted)]">
              <p className="font-medium">Empty canvas</p>
              <p className="mt-1 text-xs">
                Double-click anywhere to drop a note, or pick a tool and click where it goes. Drag to pan, ⌘-scroll to
                zoom, shift-drag to select, space-drag to pan over elements.
              </p>
            </div>
          </div>
        )}
      </div>

      {inserting && (
        <InsertDialog
          kind={inserting.type}
          workspaceId={workspaceId}
          onCancel={() => setInserting(null)}
          onInsert={(payload) => {
            const type = inserting.type;
            setInserting(null);
            startPlacing({
              tool: type,
              type,
              label: INSERT_LABELS[type],
              place: (point) => addElement(type, point, payload as Partial<CanvasElement>),
            });
          }}
          onUpload={(file) => {
            const type = inserting.type;
            setInserting(null);
            startPlacing({
              tool: type,
              type: elementTypeFor(file) ?? type,
              label: INSERT_LABELS[type],
              place: (point) => void handleFiles([file], point),
            });
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
              const extra = {
                spreadsheetId: ref.spreadsheetId,
                sheetId: ref.sheetId,
                cell: ref.cell,
                label: ref.label,
              } as Partial<CanvasElement>;
              startPlacing({
                tool: 'sheetCell',
                type: 'sheetCell',
                label: 'spreadsheet cell',
                place: (point) => addElement('sheetCell', point, extra),
              });
            } else {
              const extra = {
                spreadsheetId: ref.spreadsheetId,
                sheetId: ref.sheetId,
                chartId: ref.chartId,
                label: ref.label,
              } as Partial<CanvasElement>;
              startPlacing({
                tool: 'sheetChart',
                type: 'sheetChart',
                label: 'chart',
                place: (point) => addElement('sheetChart', point, extra),
              });
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
          members={members.data ?? []}
          onExit={() => setPresenting(null)}
          onOpenDocument={onOpenDocument}
        />
      )}
    </div>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-[var(--color-line)]" />;

const SHAPES: { id: ConnectorShape; label: string; icon: IconName }[] = [
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

/** Contextual controls for whichever shape is selected. */
function ShapeBar({
  shape,
  onChange,
}: {
  shape: ShapeElement;
  onChange: (patch: Partial<ShapeElement>) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-1.5 text-xs">
      <span className="text-[var(--color-muted)]">Shape</span>
      {SHAPE_KINDS.map((kind) => (
        <Chip key={kind} label={kind} active={shape.shape === kind} onClick={() => onChange({ shape: kind })}>
          <Icon name={SHAPE_ICONS[kind]} />
        </Chip>
      ))}

      <Divider />
      <span className="text-[var(--color-muted)]">Fill</span>
      {SHAPE_FILLS.map((fill) => (
        <Tooltip key={fill} label={fill === 'transparent' ? 'No fill' : 'Fill colour'}>
        <button
          aria-label={fill === 'transparent' ? 'No fill' : 'Fill colour'}
          onClick={() => onChange({ fill })}
          className={cx(
            'h-7 w-7 rounded-md border-2',
            (shape.fill ?? 'transparent') === fill ? 'border-[var(--color-ink)]' : 'border-[var(--color-line)]',
          )}
          style={
            fill === 'transparent'
              ? {
                  // A diagonal bar is the usual way to show "no fill".
                  backgroundImage:
                    'linear-gradient(45deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)',
                }
              : { background: fill }
          }
        />
        </Tooltip>
      ))}

      <Divider />
      <span className="text-[var(--color-muted)]">Edge</span>
      {DASHES.map((dash) => (
        <Chip
          key={dash.id}
          label={dash.label}
          active={(shape.dash ?? 'solid') === dash.id}
          onClick={() => onChange({ dash: dash.id })}
        >
          <LineSample dash={dash.id} />
        </Chip>
      ))}
      {CONNECTOR_COLORS.map((color) => (
        <Tooltip key={color} label="Edge colour">
          <button
            aria-label="Edge colour"
            onClick={() => onChange({ stroke: color })}
            className={cx(
              'h-7 w-7 rounded-full border-2',
              (shape.stroke ?? CONNECTOR_COLORS[0]) === color
                ? 'border-[var(--color-ink)]'
                : 'border-transparent',
            )}
            style={{ background: color }}
          />
        </Tooltip>
      ))}
      <Tooltip label="Edge thickness">
        <select
          aria-label="Edge thickness"
          value={shape.strokeWidth ?? 2}
          onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
          className="h-8 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 outline-none"
        >
          {[1, 2, 3, 5, 8].map((width) => (
            <option key={width} value={width}>
              {width}px
            </option>
          ))}
        </select>
      </Tooltip>
    </div>
  );
}

/** Contextual controls for whichever connector is selected. */
function ConnectorBar({
  connector,
  onChange,
}: {
  connector: ConnectorElement;
  onChange: (patch: Partial<ConnectorElement>) => void;
}) {
  const arrowEnd = connector.arrowEnd ?? connector.arrow ?? true;
  const arrowStart = connector.arrowStart ?? false;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-1.5 text-xs">
      <span className="text-[var(--color-muted)]">Line</span>
      {SHAPES.map((shape) => (
        <Chip
          key={shape.id}
          label={shape.label}
          active={(connector.shape ?? 'straight') === shape.id}
          onClick={() => onChange({ shape: shape.id })}
        >
          <Icon name={shape.icon} />
        </Chip>
      ))}

      <Divider />
      <span className="text-[var(--color-muted)]">Ends</span>
      <Chip label="Arrow at start" active={arrowStart} onClick={() => onChange({ arrowStart: !arrowStart })}>
        <Icon name="arrow-left" />
      </Chip>
      <Chip label="Arrow at end" active={arrowEnd} onClick={() => onChange({ arrowEnd: !arrowEnd })}>
        <Icon name="arrow-right" />
      </Chip>

      <Divider />
      <span className="text-[var(--color-muted)]">Style</span>
      {DASHES.map((dash) => (
        <Chip
          key={dash.id}
          label={dash.label}
          active={(connector.dash ?? 'solid') === dash.id}
          onClick={() => onChange({ dash: dash.id })}
        >
          <LineSample dash={dash.id} />
        </Chip>
      ))}

      <Divider />
      {CONNECTOR_COLORS.map((color) => (
        <Tooltip key={color} label="Connector colour">
          <button
            aria-label="Connector colour"
            onClick={() => onChange({ color })}
            className={cx(
              'h-7 w-7 rounded-full border-2',
              (connector.color ?? CONNECTOR_COLORS[0]) === color
                ? 'border-[var(--color-ink)]'
                : 'border-transparent',
            )}
            style={{ background: color }}
          />
        </Tooltip>
      ))}

      {(connector.midX !== undefined || connector.midY !== undefined || connector.bend) && (
        <>
          <Divider />
          <Tooltip label="Discard manual routing and let the line re-derive itself">
            <button
              onClick={() => onChange({ midX: undefined, midY: undefined, bend: undefined })}
              className="h-8 rounded-md bg-[var(--color-surface)] px-2.5 hover:bg-[var(--color-line)]"
            >
              Reset route
            </button>
          </Tooltip>
        </>
      )}

      <input
        value={connector.label ?? ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label"
        className="ml-auto w-32 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
      />
    </div>
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
          'grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm transition-colors',
          active
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-surface)] hover:bg-[var(--color-line)]',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ToolButton({
  label,
  children,
  onClick,
  active,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <button
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        disabled={disabled}
        className={cx(
          'grid h-9 w-9 place-items-center rounded-md text-base transition-colors disabled:opacity-40',
          active
            ? 'bg-[var(--color-accent)] text-white'
            : 'hover:bg-[var(--color-surface)] text-[var(--color-ink)]',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

const INSERT_LABELS: Record<NonNullable<Inserting>['type'], string> = {
  link: 'document card',
  embed: 'embed',
  image: 'image',
  audio: 'audio',
  video: 'video',
};

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
  const documents = useAllDocuments(workspaceId, { sort: 'updated', archived: false, limit: 200 });

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]';

  const titles: Record<typeof kind, string> = {
    embed: 'Embed a webpage or video',
    image: 'Add an image',
    audio: 'Add audio',
    video: 'Add a video',
    link: 'Link a document',
  };

  function submit() {
    if (kind === 'link') {
      const chosen = documents.data?.documents.find((d) => d.id === documentId);
      if (!chosen) return;
      onInsert({ documentId: chosen.id, title: chosen.title });
      return;
    }
    if (!url.trim()) return;
    onInsert({ url: url.trim() });
  }

  return (
    <Modal
      title={titles[kind]}
      description={
        kind === 'embed'
          ? 'YouTube, Vimeo and Loom links are converted to their embeddable form. Some sites refuse to be framed.'
          : kind === 'link'
            ? 'Places a card on the canvas. Double-click the card to open the document.'
            : 'Paste a URL, or upload a file. Files can also be dropped straight onto the board.'
      }
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="text-xs"
            onClick={submit}
            disabled={kind === 'link' ? !documentId : !url.trim()}
          >
            Add to canvas
          </Button>
        </>
      }
    >
      {kind === 'link' ? (
        <select
          className={field}
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          size={8}
        >
          <option value="">Choose a document…</option>
          {(documents.data?.documents ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      ) : (
        <div className="space-y-2">
          <input
            autoFocus
            className={field}
            value={url}
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
          {ACCEPT[kind] && (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
              <input
                type="file"
                accept={ACCEPT[kind]}
                className="hidden"
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
