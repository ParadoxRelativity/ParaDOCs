import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONNECTOR_COLORS,
  DEFAULT_SIZE,
  NOTE_COLORS,
  NODE_COLORS,
  NODE_GAP_X,
  NODE_GAP_Y,
  SHAPE_FILLS,
  SHAPE_KINDS,
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
import { cx, useAutosave } from '../../lib/util';
import { useAllDocuments, useCreateDocument, useUploadFile, type DocumentPatch } from '../../api/hooks';
import { useToast } from '../Toast';
import CanvasSurface, { type Viewport } from './CanvasSurface';
import PresentMode from './PresentMode';
import { Modal } from '../Modal';
import { Button, Tooltip } from '../ui';

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

const SHAPE_ICONS: Record<ShapeKind, string> = {
  rectangle: '▭',
  ellipse: '◯',
  diamond: '◇',
  triangle: '△',
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
  const toast = useToast();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The connector tool is a mode, not a one-shot action: it stays on so several
  // connections can be drawn in a row.
  const [connectorTool, setConnectorTool] = useState(false);
  // The shape tool is a mode too: pick a kind, then drag out its bounds.
  const [shapeTool, setShapeTool] = useState<ShapeKind | null>(null);
  // Set briefly so a node created by the + button opens for typing.
  const [editRequestId, setEditRequestId] = useState<string | null>(null);
  const [inserting, setInserting] = useState<Inserting>(null);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [title, setTitle] = useState(doc.title);

  const titleSave = useAutosave<string>((value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== doc.title) onPatch({ title: trimmed });
  }, 600);

  const frames = useMemo(
    () =>
      elements
        .filter((el): el is FrameElement => el.type === 'frame')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [elements],
  );

  /** Drops new elements into the middle of what the user is currently looking at. */
  const viewCentre = useCallback(() => {
    const el = document.getElementById('paradocs-canvas');
    const rect = el?.getBoundingClientRect();
    const width = rect?.width ?? 1200;
    const height = rect?.height ?? 800;
    return {
      x: (width / 2 - viewport.x) / viewport.scale,
      y: (height / 2 - viewport.y) / viewport.scale,
    };
  }, [viewport]);

  const addElement = useCallback(
    (type: CanvasElement['type'], extra: Partial<CanvasElement> = {}) => {
      const centre = viewCentre();
      const size = DEFAULT_SIZE[type];
      // Cascade successive drops so a second element never lands exactly on the
      // first and hides it.
      const step = (elements.length % 8) * 28;
      const id = create(type, {
        x: centre.x - size.width / 2 + step,
        y: centre.y - size.height / 2 + step,
        ...extra,
      } as never);
      setSelectedIds(new Set([id]));
      return id;
    },
    [create, viewCentre, elements.length],
  );

  /**
   * Creates a real document in the workspace and drops a card for it, so a board
   * can spawn the documents it references without leaving the canvas.
   */
  async function createDocumentCard() {
    const doc = await createDocument.mutateAsync({ title: 'Untitled', folderId: null });
    addElement('link', { documentId: doc.id, title: doc.title } as Partial<CanvasElement>);
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
            <ToolButton label="Sticky note — or double-click the board" onClick={() => addElement('note', { text: '', color: NOTE_COLORS[0] })}>
              🗒
            </ToolButton>
            <ToolButton label="Text label" onClick={() => addElement('text', { text: '' })}>
              T
            </ToolButton>
            <ToolButton label="Create a document and place it here" onClick={createDocumentCard}>
              ✚
            </ToolButton>
            <ToolButton label="Place an existing document on the board" onClick={() => setInserting({ type: 'link' })}>
              📄
            </ToolButton>
            <ToolButton label="Embed a webpage or video by URL" onClick={() => setInserting({ type: 'embed' })}>
              ▶
            </ToolButton>
            <ToolButton label="Image — by URL, upload, paste or drop" onClick={() => setInserting({ type: 'image' })}>
              🖼
            </ToolButton>
            <ToolButton label="Audio — by URL or upload" onClick={() => setInserting({ type: 'audio' })}>
              🎵
            </ToolButton>
            <ToolButton label="Video — by URL or upload" onClick={() => setInserting({ type: 'video' })}>
              🎬
            </ToolButton>
            <ToolButton
              label="Mind map — drops a root node you can branch from"
              onClick={() => {
                const id = addElement('node', {
                  text: '',
                  color: NODE_COLORS[0],
                } as Partial<CanvasElement>);
                setEditRequestId(id);
              }}
            >
              🌳
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
              }}
            >
              ▭
            </ToolButton>
            <ToolButton
              label="Frame (presentation slide)"
              onClick={() => addElement('frame', { name: `Frame ${frames.length + 1}`, order: frames.length })}
            >
              ⬚
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
              }}
            >
              ↔
            </ToolButton>
            <ToolButton label="Delete selection (or press Delete)" disabled={selectedIds.size === 0} onClick={deleteSelection}>
              🗑
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
                + Child
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
                <span
                  key={peer.clientId}
                  title={peer.name}
                  className="grid h-6 w-6 place-items-center rounded-full border-2 border-[var(--color-canvas)] text-[10px] font-semibold text-white"
                  style={{ background: peer.color }}
                >
                  {peer.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          )}
          <span className="tabular-nums text-xs text-[var(--color-muted)]">
            {elements.length} item{elements.length === 1 ? '' : 's'} · {Math.round(viewport.scale * 100)}%
          </span>
          <ToolButton label="Zoom to fit everything on the board" onClick={zoomToFit}>
            ⤢
          </ToolButton>
          <Tooltip label="Present the frames as slides">
            <Button variant="subtle" className="text-sm" onClick={() => setPresenting(0)}>
              ▶ Present
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
              {SHAPE_ICONS[kind]}
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
          connectorTool={connectorTool}
          shapeTool={shapeTool}
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
          }}
          onConnect={completeConnection}
          onUpdate={update}
          onCommit={updateMany}
          onBringToFront={bringToFront}
          onOpenDocument={onOpenDocument}
          dark={dark}
          onDeleteSelection={deleteSelection}
          onFiles={handleFiles}
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
          }}
        />

        {elements.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center text-sm text-[var(--color-muted)]">
              <p className="font-medium">Empty canvas</p>
              <p className="mt-1 text-xs">
                Double-click anywhere to drop a note, or use the toolbar. Drag to pan, ⌘-scroll to
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
            setInserting(null);
            addElement(inserting.type, payload as Partial<CanvasElement>);
          }}
          onUpload={async (file) => {
            setInserting(null);
            await handleFiles([file], viewCentre());
          }}
        />
      )}

      {presenting !== null && (
        <PresentMode
          frames={frames}
          elements={elements}
          startIndex={Math.max(0, presenting)}
          dark={dark}
          onExit={() => setPresenting(null)}
          onOpenDocument={onOpenDocument}
        />
      )}
    </div>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-[var(--color-line)]" />;

const SHAPES: { id: ConnectorShape; label: string; icon: string }[] = [
  { id: 'straight', label: 'Straight', icon: '╱' },
  { id: 'curved', label: 'Curved', icon: '∿' },
  { id: 'elbow', label: 'Right angles', icon: '⌐' },
];

const DASHES: { id: ConnectorDash; label: string; icon: string }[] = [
  { id: 'solid', label: 'Solid', icon: '───' },
  { id: 'dashed', label: 'Dashed', icon: '╌╌╌' },
  { id: 'dotted', label: 'Dotted', icon: '┈┈┈' },
];

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
          {SHAPE_ICONS[kind]}
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
          {dash.icon}
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
          {shape.icon}
        </Chip>
      ))}

      <Divider />
      <span className="text-[var(--color-muted)]">Ends</span>
      <Chip label="Arrow at start" active={arrowStart} onClick={() => onChange({ arrowStart: !arrowStart })}>
        ←
      </Chip>
      <Chip label="Arrow at end" active={arrowEnd} onClick={() => onChange({ arrowEnd: !arrowEnd })}>
        →
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
          {dash.icon}
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
