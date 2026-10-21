import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_THEME,
  plainTextParagraphs,
  slideElementText,
  startSlideId,
  type PresentationSummary,
  type SlideElement,
  type SlideElementType,
  type WorkspaceMember,
  type ZOrder,
} from '@paradocs/shared';
import type { CollabSession, CollabStatus, Peer } from '../../lib/collaboration';
import { useSearchParams } from 'react-router-dom';
import { alignBoxes, distributeBoxes, type Alignment } from '../../lib/canvasArrange';
import { useBackHandler } from '../../lib/back';
import { useIsMobile } from '../../lib/mobile';
import { usePeerSlideStates, usePublishSlideState } from '../../lib/slidesPresence';
import { useSlidesDeck } from '../../lib/slidesStore';
import { cx } from '../../lib/util';
import { useMembers } from '../../api/hooks';
import { Button, IconButton } from '../ui';
import Icon from '../Icon';
import SlideInspector from './SlideInspector';
import SlideRail from './SlideRail';
import SlideShow from './SlideShow';
import SlideStage, { type Zoom } from './SlideStage';
import {
  slideFileHandlers,
  slideInsertTools,
  slidePanels,
  slideToolbarActions,
  type SlideEditorContext,
} from './slideExtensions';
import './slideBuiltins';
import './slideShowBuiltins';
import './slideNotes';
import './presenterView';
import './slideComments';
import './slideBuildBuiltins';
import './slideShowLive';
import './slideContent';
import { CANVAS_CLIP_MIME, SlideInsertDialogs, parseCanvasClip, pasteCanvasSelection } from './SlideLiveElements';
import { SlideDesignHost } from './slideDesign';
import { SlideExportHost } from './slideExport';
import SlideImportHost from './SlideImportHost';
import { usePowerPointPaste } from './SlidePowerPointPaste';

const EMPTY_MEMBERS: WorkspaceMember[] = [];
const ZOOMS: Zoom[] = ['fit', 0.25, 0.5, 0.75, 1, 1.5, 2];

/** What a copy puts on the clipboard: readable text for anywhere else, and the elements themselves for another slide. */
const CLIP_MIME = 'application/x-paradocs-slide-elements';
const PASTEABLE: SlideElementType[] = ['text', 'shape', 'image', 'video', 'embed', 'sheetCell', 'sheetChart', 'workItem', 'workItemProgress', 'person', 'connector', 'richText', 'table', 'link'];
const MAX_PASTE = 200;

interface ClipPayload {
  presentationId: string;
  slideId: string;
  elements: SlideElement[];
}

function parseClip(raw: string | undefined): ClipPayload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ClipPayload>;
    if (!value || !Array.isArray(value.elements)) return null;
    // Clipboard contents are another page's to write: keep only well-formed elements of known types.
    const elements = value.elements.filter(
      (el): el is SlideElement =>
        !!el &&
        typeof el === 'object' &&
        PASTEABLE.includes((el as SlideElement).type) &&
        [el.x, el.y, el.width, el.height].every((n) => Number.isFinite(n)),
    );
    if (elements.length === 0) return null;
    return { presentationId: String(value.presentationId), slideId: String(value.slideId), elements: elements.slice(0, MAX_PASTE) };
  } catch {
    return null;
  }
}

/** True when a key press or clipboard event belongs to a text field rather than to the slide. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null;
}

interface Props {
  presentation: PresentationSummary;
  workspaceId: string;
  canEdit: boolean;
  session: CollabSession;
  peers: Peer[];
  status: CollabStatus;
}

/**
 * The slide editor: a rail of slides, the slide on stage, and an inspector,
 * over one collaborative Y.Doc.
 *
 * It owns what is local to this person (which slide is open, what is
 * selected, zoom) and leaves everything shared to the Y.Doc through
 * lib/slidesStore. What later stories add comes in through the registries in
 * slideExtensions.tsx rather than edits to this file.
 */
export default function SlidesEditor({ presentation, workspaceId, canEdit, session, peers, status }: Props) {
  const { deck, history, actions } = useSlidesDeck(session.ydoc);
  const members = useMembers(workspaceId).data ?? EMPTY_MEMBERS;
  const mobile = useIsMobile();
  const { slides, settings } = deck;
  const theme = deck.themes.find((t) => t.id === settings.themeId) ?? deck.themes[0] ?? DEFAULT_THEME;

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [railSelection, setRailSelection] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [scale, setScale] = useState(1);
  const [grid, setGrid] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The slideshow is local to this person: it reads the deck and writes nothing to it.
  const [show, setShow] = useState<{ startId: string | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastIndex = useRef(0);
  const slideParam = useSearchParams()[0].get('slide');
  const appliedParam = useRef<string | null>(null);

  const slide = slides.find((s) => s.id === currentId) ?? null;
  const currentIndex = slide ? slides.indexOf(slide) : -1;
  if (currentIndex >= 0) lastIndex.current = currentIndex;

  const openSlide = useCallback((id: string | null) => {
    setCurrentId(id);
    setRailSelection(id ? new Set([id]) : new Set());
    setSelectedIds(new Set());
    setEditingId(null);
  }, []);

  // The open slide is gone (deleted by someone else, or by us): go to its neighbour. Before any is open, the first.
  useEffect(() => {
    if (slide || slides.length === 0) {
      if (!slide && currentId) openSlide(null);
      return;
    }
    // A link (search result, slide link) names the slide to open; an unknown one falls back to the first.
    const linked = slideParam !== appliedParam.current ? slides.find((s) => s.id === slideParam) : undefined;
    if (linked) appliedParam.current = slideParam;
    openSlide((linked ?? slides[Math.min(lastIndex.current, slides.length - 1)]).id);
  }, [slide, slides, currentId, openSlide, slideParam]);

  // Following a link to another slide of the deck already open moves there too.
  useEffect(() => {
    if (!slideParam || slideParam === appliedParam.current) return;
    if (slides.some((s) => s.id === slideParam)) {
      appliedParam.current = slideParam;
      openSlide(slideParam);
    }
  }, [slideParam, slides, openSlide]);

  // Slides in the rail's selection that no longer exist drop out of it.
  useEffect(() => {
    const live = new Set(slides.map((s) => s.id));
    if ([...railSelection].some((id) => !live.has(id))) {
      const kept = new Set([...railSelection].filter((id) => live.has(id)));
      if (currentId && live.has(currentId)) kept.add(currentId);
      setRailSelection(kept);
    }
  }, [slides, railSelection, currentId]);

  // Leaving a text edit drops focus with the textarea; take it back so shortcuts keep working.
  useEffect(() => {
    if (editingId === null && document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [editingId]);

  usePublishSlideState(session, currentId, selectedIds);
  const slidePeers = usePeerSlideStates(session);

  const selection = useMemo(() => (slide ? slide.elements.filter((el) => selectedIds.has(el.id)) : []), [slide, selectedIds]);

  const ctx: SlideEditorContext = {
    presentationId: presentation.id,
    workspaceId,
    canEdit,
    session,
    slide,
    slides,
    selection,
    theme,
    deck,
    actions,
    select: (ids) => setSelectedIds(new Set(ids)),
    edit: setEditingId,
    center: { x: settings.size.width / 2, y: settings.size.height / 2 },
    present: (from) => setShow({ startId: startSlideId(slides, from === 'current' ? currentId : null) }),
  };
  const powerPoint = usePowerPointPaste(ctx, (ids) => {
    openSlide(ids[0] ?? null);
    setRailSelection(new Set(ids));
  });

  // ---- slide operations (rail) --------------------------------------------

  const railIds = () => slides.filter((s) => railSelection.has(s.id)).map((s) => s.id);

  const openFromRail = (id: string, mode: 'replace' | 'toggle' | 'range') => {
    if (mode === 'replace' || !currentId) return openSlide(id);
    if (mode === 'toggle') {
      const next = new Set(railSelection);
      if (next.has(id) && next.size > 1) next.delete(id);
      else next.add(id);
      setRailSelection(next);
      if (next.has(id)) setCurrentId(id);
      return;
    }
    const a = slides.findIndex((s) => s.id === currentId);
    const b = slides.findIndex((s) => s.id === id);
    setRailSelection(new Set(slides.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id)));
  };

  const addSlide = () => {
    if (!canEdit) return;
    // A new slide uses the layout of the one it follows (Title and content after a Title slide), so it opens ready to type into.
    const after = slide?.layoutId;
    openSlide(actions.addSlide(currentId, !after || after === 'title' ? 'titleAndContent' : after));
  };
  const duplicateSlides = () => {
    const ids = railIds();
    if (!canEdit || ids.length === 0) return;
    const copies = actions.duplicateSlides(ids);
    if (copies[0]) openSlide(copies[0]);
  };
  const deleteSlides = () => {
    const ids = railIds();
    if (!canEdit || ids.length === 0) return;
    actions.deleteSlides(ids);
  };
  const toggleHidden = () => {
    const ids = railIds();
    if (!canEdit || ids.length === 0) return;
    actions.setHidden(ids, !ids.every((id) => slides.find((s) => s.id === id)?.hidden));
  };
  const moveSlides = (toIndex: number) => {
    const ids = railIds();
    if (canEdit && ids.length) actions.moveSlides(ids, toIndex);
  };
  const step = (delta: number) => {
    const next = slides[Math.min(Math.max(currentIndex + delta, 0), slides.length - 1)];
    if (next && next.id !== currentId) openSlide(next.id);
  };

  // ---- element operations (stage) -----------------------------------------

  const deleteElements = () => {
    if (!canEdit || !slide || selection.length === 0) return;
    actions.deleteElements(slide.id, selection.map((el) => el.id));
    setSelectedIds(new Set());
    setEditingId(null);
  };
  const duplicateElements = () => {
    if (!canEdit || !slide || selection.length === 0) return;
    setSelectedIds(new Set(actions.duplicateElements(slide.id, selection.map((el) => el.id))));
  };
  const arrange = (how: ZOrder) => slide && actions.reorder(slide.id, selectedIds, how);
  const align = (alignment: Alignment) => {
    if (!slide || selection.length === 0) return;
    // One element aligns to the slide; several align to one another.
    const boxes: { id: string; x: number; y: number; width: number; height: number }[] = selection.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
    if (boxes.length === 1) boxes.push({ id: '', x: 0, y: 0, width: settings.size.width, height: settings.size.height });
    const patches = alignBoxes(boxes, alignment).filter((p) => p.id);
    if (patches.length) actions.updateElements(slide.id, patches.map(({ id, patch }) => ({ id, patch: patch as Record<string, unknown> })));
    actions.checkpoint();
  };
  const distribute = (axis: 'x' | 'y') => {
    if (!slide) return;
    const patches = distributeBoxes(selection, axis);
    if (patches.length) actions.updateElements(slide.id, patches.map(({ id, patch }) => ({ id, patch: patch as Record<string, unknown> })));
    actions.checkpoint();
  };
  const nudge = (dx: number, dy: number) => {
    if (!canEdit || !slide || selection.length === 0) return;
    actions.updateElements(slide.id, selection.map((el) => ({ id: el.id, patch: { x: el.x + dx, y: el.y + dy } })));
  };

  // ---- clipboard ------------------------------------------------------------

  const copyTo = (data: DataTransfer) => {
    if (!slide || selection.length === 0) return false;
    const payload: ClipPayload = { presentationId: presentation.id, slideId: slide.id, elements: selection };
    data.setData(CLIP_MIME, JSON.stringify(payload));
    data.setData('text/plain', selection.map(slideElementText).filter(Boolean).join('\n'));
    return true;
  };
  const onCopy = (e: React.ClipboardEvent) => {
    if (inTextField(e.target) || !copyTo(e.clipboardData)) return;
    e.preventDefault();
  };
  const onCut = (e: React.ClipboardEvent) => {
    if (inTextField(e.target) || !canEdit || !copyTo(e.clipboardData)) return;
    e.preventDefault();
    deleteElements();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (inTextField(e.target) || !canEdit) return;
    // Slides copied in PowerPoint become slides, rather than the picture of them PowerPoint puts beside them.
    if (powerPoint.paste(e.clipboardData)) {
      e.preventDefault();
      return;
    }
    if (!slide) return;
    const clip = parseClip(e.clipboardData.getData(CLIP_MIME));
    e.preventDefault();
    // Pictures and video on the clipboard (a screenshot, a copied image) go to whoever takes that kind of file.
    if (!clip && e.clipboardData.files.length && handleFiles([...e.clipboardData.files])) return;
    // Elements copied from a canvas land on the slide scaled to fit it.
    const board = clip ? null : parseCanvasClip(e.clipboardData.getData(CANVAS_CLIP_MIME));
    if (board) {
      setSelectedIds(new Set(pasteCanvasSelection(actions, slide.id, settings.size, board)));
      return;
    }
    if (clip) {
      // A copy pasted onto the slide it came from lands beside the original rather than on top of it.
      const offset = clip.presentationId === presentation.id && clip.slideId === slide.id ? 40 : 0;
      setSelectedIds(new Set(actions.pasteElements(slide.id, clip.elements, offset)));
      return;
    }
    const text = e.clipboardData.getData('text/plain').trim().slice(0, 5000);
    if (!text) return;
    const width = 960;
    const paragraphs = plainTextParagraphs(text);
    const id = actions.createElement(slide.id, {
      type: 'richText',
      paragraphs,
      fontSize: 48,
      width,
      // Tall enough for its lines at the default size; autofit shrinks the rest.
      height: Math.min(settings.size.height - 80, Math.max(150, paragraphs.length * 72 + 24)),
      x: Math.round(settings.size.width / 2 - width / 2),
      y: Math.round(settings.size.height / 2 - 75),
    });
    setSelectedIds(new Set([id]));
  };

  // ---- files (paste and drop) -----------------------------------------------

  /** Hands files to the handlers that take them; returns whether any did. */
  const handleFiles = (files: File[], at?: { x: number; y: number }): boolean => {
    if (!canEdit || !slide) return false;
    let taken = false;
    for (const handler of slideFileHandlers()) {
      const mine = files.filter(handler.accepts);
      if (mine.length === 0) continue;
      taken = true;
      void handler.run(ctx, mine, at);
    }
    return taken;
  };
  const onDragOver = (e: React.DragEvent) => {
    if (canEdit && slide && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    const page = (e.currentTarget as HTMLElement).querySelector('[data-slide-stage] [role="group"]');
    const rect = page?.getBoundingClientRect();
    const at = rect && scale > 0 ? { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale } : undefined;
    if (handleFiles([...e.dataTransfer.files], at)) e.preventDefault();
  };

  // ---- keyboard -------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (inTextField(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const inRail = (e.target as HTMLElement).closest?.('[data-slide-rail]') !== null;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (mod && key.toLowerCase() === 'z') {
      handled();
      if (e.shiftKey) actions.redo();
      else actions.undo();
    } else if (mod && key.toLowerCase() === 'y') {
      handled();
      actions.redo();
    } else if (mod && key.toLowerCase() === 'm' && canEdit) {
      handled();
      addSlide();
    } else if (mod && key.toLowerCase() === 'd' && canEdit) {
      handled();
      if (inRail || selection.length === 0) duplicateSlides();
      else duplicateElements();
    } else if (mod && key.toLowerCase() === 'a' && slide && !inRail) {
      handled();
      setSelectedIds(new Set(slide.elements.map((el) => el.id)));
    } else if (mod && (key === ']' || key === '[') && canEdit && selection.length) {
      handled();
      arrange(key === ']' ? (e.shiftKey ? 'front' : 'forward') : e.shiftKey ? 'back' : 'backward');
    } else if (key === 'Delete' || key === 'Backspace') {
      if (!canEdit) return;
      handled();
      if (inRail || selection.length === 0) deleteSlides();
      else deleteElements();
    } else if (key === 'Escape') {
      if (editingId) setEditingId(null);
      else if (selectedIds.size) setSelectedIds(new Set());
      else if (railSelection.size > 1 && currentId) openSlide(currentId);
    } else if (key === 'PageDown' || (inRail && key === 'ArrowDown') || (inRail && key === 'ArrowRight')) {
      handled();
      step(1);
    } else if (key === 'PageUp' || (inRail && key === 'ArrowUp') || (inRail && key === 'ArrowLeft')) {
      handled();
      step(-1);
    } else if (key.startsWith('Arrow') && !inRail && selection.length && canEdit && !editingId) {
      handled();
      const d = e.shiftKey ? 10 : 1;
      nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
    } else if (key === 'Enter' && selection.length === 1 && canEdit && (e.target as HTMLElement).closest?.('[data-slide-stage]')) {
      handled();
      setEditingId(selection[0].id);
    }
  };

  // Android back leaves selection first (the properties sheet, a text edit, then the selected elements or slides), then the editor.
  useBackHandler(
    () => {
      if (sheetOpen) setSheetOpen(false);
      else if (editingId) setEditingId(null);
      else if (selectedIds.size) setSelectedIds(new Set());
      else if (currentId) openSlide(currentId);
    },
    { active: sheetOpen || editingId !== null || selectedIds.size > 0 || railSelection.size > 1 },
  );

  const insert = (run: (c: SlideEditorContext) => void | Promise<void>) => {
    if (slide) void run(ctx);
  };

  const showInspector = !mobile;
  const panels = slidePanels();
  const inspector = <SlideInspector ctx={ctx} handlers={{ onAlign: align, onDistribute: distribute, onArrange: arrange, onDuplicate: duplicateElements, onDelete: deleteElements }} />;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="flex h-full min-h-0 w-full flex-col outline-none"
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
    >
      {/* Toolbar */}
      <div className="scroll-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1">
        {canEdit && (
          <>
            <IconButton label="Undo (Ctrl+Z)" onClick={actions.undo} disabled={!history.canUndo}>
              <Icon name="arrow-counterclockwise" />
            </IconButton>
            <IconButton label="Redo (Ctrl+Shift+Z)" onClick={actions.redo} disabled={!history.canRedo}>
              <Icon name="arrow-clockwise" />
            </IconButton>
            <Divider />
            {slideInsertTools().map((tool) => (
              <IconButton key={tool.id} label={`Insert ${tool.label.toLowerCase()}`} onClick={() => insert(tool.run)} disabled={!slide}>
                <Icon name={tool.icon} />
              </IconButton>
            ))}
            <Divider />
          </>
        )}
        {slideToolbarActions()
          .filter((action) => canEdit || action.viewers)
          .map((action) => (
            <IconButton key={action.id} label={action.label} onClick={() => action.run(ctx)} disabled={!slide}>
              <Icon name={action.icon} />
            </IconButton>
          ))}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {status !== 'connected' && (
            <span className="text-xs text-[var(--color-muted)]" role="status">
              {status === 'connecting' ? 'Connecting...' : 'Offline, edits will sync when reconnected'}
            </span>
          )}
          {!canEdit && <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">View only</span>}
          <span className="flex -space-x-1" aria-label={`${peers.length} other ${peers.length === 1 ? 'person' : 'people'} here`}>
            {peers.slice(0, 5).map((peer) => (
              <span
                key={peer.clientId}
                title={peer.name}
                className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-[var(--color-canvas)]"
                style={{ background: peer.color }}
              >
                {peer.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
          <button
            type="button"
            aria-pressed={grid}
            title="Show grid (moves snap to it)"
            onClick={() => setGrid((g) => !g)}
            className={cx('grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-surface)]', grid ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]')}
          >
            <Icon name="grid-3x3" />
          </button>
          <select
            aria-label="Zoom"
            value={String(zoom)}
            onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-1 text-xs"
          >
            {ZOOMS.map((z) => (
              <option key={String(z)} value={String(z)}>
                {z === 'fit' ? `Fit (${Math.round(scale * 100)}%)` : `${Math.round(z * 100)}%`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={cx('flex min-h-0 flex-1', mobile ? 'flex-col' : 'flex-row')}>
        {!mobile && (
          <div data-slide-rail>
            <SlideRail {...railProps()} horizontal={false} />
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
            {slide ? (
              <SlideStage
                // One stage per slide, so a drag, a text edit or a selection never carries over to another.
                key={slide.id}
                slide={slide}
                size={settings.size}
                theme={theme}
                canEdit={canEdit}
                zoom={zoom}
                grid={grid}
                selectedIds={selectedIds}
                onSelect={setSelectedIds}
                editingId={editingId}
                onEditing={setEditingId}
                members={members}
                actions={actions}
                session={session}
                peers={slidePeers}
                onScale={setScale}
              />
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--color-muted)]">
                <div className="space-y-3">
                  <Icon name="easel2" className="text-3xl" />
                  <p>{canEdit ? 'This presentation has no slides yet.' : 'This presentation has no slides.'}</p>
                  {canEdit && (
                    <Button variant="primary" onClick={addSlide}>
                      <Icon name="plus-lg" /> Add a slide
                    </Button>
                  )}
                </div>
              </div>
            )}
            {powerPoint.host}
          </div>
          {slide && panels.length > 0 && (
            <div className="shrink-0 border-t border-[var(--color-line)]">
              {panels.map((panel) => (
                <div key={panel.id}>{panel.render(ctx)}</div>
              ))}
            </div>
          )}

          {mobile && canEdit && selection.length > 0 && (
            <div className="flex shrink-0 items-center justify-around border-t border-[var(--color-line)] bg-[var(--color-canvas)] p-1">
              <Button onClick={() => setSheetOpen(true)}>
                <Icon name="sliders" /> Properties
              </Button>
              <Button onClick={duplicateElements}>
                <Icon name="copy" /> Duplicate
              </Button>
              <Button variant="danger" onClick={deleteElements}>
                <Icon name="trash" /> Delete
              </Button>
            </div>
          )}
        </div>

        {showInspector && (
          <aside aria-label="Inspector" className="w-60 shrink-0 border-l border-[var(--color-line)] bg-[var(--color-canvas)]">
            {inspector}
          </aside>
        )}

        {mobile && (
          <div data-slide-rail>
            <SlideRail {...railProps()} horizontal />
          </div>
        )}
      </div>

      <SlideDesignHost ctx={ctx} />
      <SlideExportHost ctx={ctx} />

      {show && (
        <SlideShow
          slides={slides}
          size={settings.size}
          theme={theme}
          presentationId={presentation.id}
          workspaceId={workspaceId}
          ydoc={session.ydoc}
          startId={show.startId}
          onExit={() => setShow(null)}
        />
      )}

      <SlideInsertDialogs />
      <SlideImportHost presentationId={presentation.id} />

      {mobile && sheetOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[60%] overflow-hidden rounded-t-xl border-t border-[var(--color-line)] bg-[var(--color-canvas)] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-1.5">
            <span className="text-sm font-medium">Properties</span>
            <IconButton label="Close properties" onClick={() => setSheetOpen(false)}>
              <Icon name="x-lg" />
            </IconButton>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">{inspector}</div>
        </div>
      )}
    </div>
  );

  function railProps() {
    return {
      slides,
      size: settings.size,
      theme,
      currentId,
      selection: railSelection,
      canEdit,
      peers: slidePeers,
      onOpen: openFromRail,
      onAdd: addSlide,
      onDuplicate: duplicateSlides,
      onDelete: deleteSlides,
      onToggleHidden: toggleHidden,
      onMove: moveSlides,
    };
  }
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[var(--color-line)]" />;
}
