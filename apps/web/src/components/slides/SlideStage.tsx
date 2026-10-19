import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  RESIZE_HANDLES,
  fitScale,
  resizeBox,
  rotationToward,
  visibleBounds,
  type ResizeHandle,
  type SlideElement,
  type SlideSize,
  type SlideSnapshot,
  type Theme,
  type WorkspaceMember,
} from '@paradocs/shared';
import type { CollabSession } from '../../lib/collaboration';
import { usePublishPointer } from '../../lib/canvasPresence';
import { snapMove, snapResize, unionRect, type Guide, type Rect } from '../../lib/canvasArrange';
import type { PeerSlideState } from '../../lib/slidesPresence';
import type { SlidesActions } from '../../lib/slidesStore';
import { cx } from '../../lib/util';
import PeerCursors from '../canvas/PeerCursors';
import { SlideFrameLayer, elementBoxStyle, slideBackgroundStyle } from './SlideView';
import { SlideDocContext, slideElementRenderer } from './slideExtensions';

/** Grid spacing in slide units; moves snap to it while the grid is on. */
export const GRID = 40;
/** How close, in screen pixels, an edge must come to another before it snaps. */
const SNAP_PX = 6;
const MARGIN = 24;
const HANDLE_NAMES: Record<ResizeHandle, string> = {
  n: 'top',
  ne: 'top right',
  e: 'right',
  se: 'bottom right',
  s: 'bottom',
  sw: 'bottom left',
  w: 'left',
  nw: 'top left',
};
const CURSORS: Record<ResizeHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

export type Zoom = 'fit' | number;

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, Rect>; union: Rect; moved: boolean; collapseTo: string | null }
  | { kind: 'resize'; handle: ResizeHandle; id: string; start: { x: number; y: number }; box: Rect & { rotation?: number } }
  | { kind: 'rotate'; id: string; box: Rect & { rotation?: number } }
  | { kind: 'marquee'; start: { x: number; y: number }; add: boolean; base: Set<string> };

interface Props {
  slide: SlideSnapshot;
  size: SlideSize;
  theme: Theme;
  canEdit: boolean;
  zoom: Zoom;
  grid: boolean;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  editingId: string | null;
  onEditing: (id: string | null) => void;
  members: WorkspaceMember[];
  actions: SlidesActions;
  session: CollabSession;
  /** Others on this slide, for their selections and cursors. */
  peers: PeerSlideState[];
  /** Reports the scale in use, so the toolbar can show "Fit" as a percentage. */
  onScale: (scale: number) => void;
}

/**
 * The slide on stage. Only this slide mounts element editors: everything else
 * in the app draws slides through the read-only SlideView.
 *
 * The slide is a fixed-size page in slide units scaled to fit (or to a chosen
 * zoom). Pointer positions are converted back into slide units, so moving,
 * resizing and the cursors other people see are the same numbers at any zoom
 * and on any screen.
 */
export default memo(function SlideStage({
  slide,
  size,
  theme,
  canEdit,
  zoom,
  grid,
  selectedIds,
  onSelect,
  editingId,
  onEditing,
  members,
  actions,
  session,
  peers,
  onScale,
}: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const drag = useRef<Drag | null>(null);
  const publishPointer = usePublishPointer(session);
  const onUpdate = useCallback(
    (id: string, patch: Record<string, unknown>) => actions.updateElements(slide.id, [{ id, patch }]),
    [actions, slide.id],
  );

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale = zoom === 'fit' ? Math.max(0.05, fitScale(size, box.width - MARGIN * 2, box.height - MARGIN * 2)) : zoom;
  useEffect(() => onScale(scale), [scale, onScale]);

  // Latest values for handlers that outlive a render (a drag spans many).
  const live = useRef({ slide, scale, size, grid, selectedIds, actions });
  live.current = { slide, scale, size, grid, selectedIds, actions };

  const pointOf = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = page.current!.getBoundingClientRect();
    const s = live.current.scale;
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }, []);

  const byId = useMemo(() => new Map(slide.elements.map((element) => [element.id, element])), [slide.elements]);

  // An element deleted by someone else leaves the selection, and the text edit it had.
  useEffect(() => {
    const gone = [...selectedIds].filter((id) => !byId.has(id));
    if (gone.length) onSelect(new Set([...selectedIds].filter((id) => byId.has(id))));
    if (editingId && !byId.has(editingId)) onEditing(null);
  }, [byId, selectedIds, editingId, onSelect, onEditing]);

  const targetsFor = useCallback((excluding: Set<string>): Rect[] => {
    const { slide: s, size: sz } = live.current;
    const others: Rect[] = [{ x: 0, y: 0, width: sz.width, height: sz.height }];
    for (const element of s.elements) if (!excluding.has(element.id)) others.push(visibleBounds(element));
    return others;
  }, []);

  const onElementDown = (e: React.PointerEvent, element: SlideElement) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Pressing inside the text being edited places the caret; it is not a drag, and must not end the edit.
    if (editingId === element.id) return;
    frame.current?.focus({ preventScroll: true });
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let next = selectedIds;
    let collapseTo: string | null = null;
    if (additive) {
      next = new Set(selectedIds);
      if (next.has(element.id)) next.delete(element.id);
      else next.add(element.id);
      onSelect(next);
      if (!next.has(element.id)) return;
    } else if (!selectedIds.has(element.id)) {
      next = new Set([element.id]);
      onSelect(next);
    } else if (selectedIds.size > 1) {
      // Pressing one of several selected: it drags them all, and a click without a drag narrows to it.
      collapseTo = element.id;
    }
    if (!canEdit) return;
    const origin = new Map<string, Rect>();
    for (const id of next) {
      const el = byId.get(id);
      if (el) origin.set(id, { x: el.x, y: el.y, width: el.width, height: el.height });
    }
    drag.current = {
      kind: 'move',
      start: pointOf(e),
      origin,
      union: unionRect([...origin.keys()].map((id) => visibleBounds(byId.get(id)!))),
      moved: false,
      collapseTo,
    };
  };

  const onPageDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    frame.current?.focus({ preventScroll: true });
    if (editingId) onEditing(null);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const start = pointOf(e);
    drag.current = { kind: 'marquee', start, add: additive, base: additive ? new Set(selectedIds) : new Set() };
    if (!additive) onSelect(new Set());
  };

  const onHandleDown = (e: React.PointerEvent, element: SlideElement, handle: ResizeHandle | 'rotate') => {
    if (e.button !== 0 || !canEdit) return;
    e.stopPropagation();
    actions.checkpoint();
    const boxNow = { x: element.x, y: element.y, width: element.width, height: element.height, rotation: element.rotation };
    drag.current =
      handle === 'rotate'
        ? { kind: 'rotate', id: element.id, box: boxNow }
        : { kind: 'resize', handle, id: element.id, start: pointOf(e), box: boxNow };
  };

  const onMove = (e: React.PointerEvent) => {
    const p = pointOf(e);
    // A touch is a finger, not a cursor: nobody wants a pointer left where a finger last was.
    if (e.pointerType !== 'touch') publishPointer(p);
    const d = drag.current;
    if (!d) return;
    // Captured only once the pointer moves, so a plain click or double-click still reaches the element it was on.
    if (!page.current!.hasPointerCapture(e.pointerId)) page.current!.setPointerCapture(e.pointerId);
    const { scale: s, size: sz, grid: snapGrid } = live.current;
    const threshold = SNAP_PX / s;
    const free = e.altKey;

    if (d.kind === 'move') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (!d.moved) {
        // A press that barely moves is a click, not a drag.
        if (Math.hypot(dx, dy) * s < 3) return;
        d.moved = true;
        actions.checkpoint();
      }
      const proposed = { ...d.union, x: d.union.x + dx, y: d.union.y + dy };
      let sx = 0;
      let sy = 0;
      let found: Guide[] = [];
      if (!free) {
        const snap = snapMove(proposed, targetsFor(new Set(d.origin.keys())), threshold);
        sx = snap.dx;
        sy = snap.dy;
        found = snap.guides;
        if (snapGrid) {
          if (sx === 0) sx = Math.round(proposed.x / GRID) * GRID - proposed.x;
          if (sy === 0) sy = Math.round(proposed.y / GRID) * GRID - proposed.y;
        }
      }
      setGuides(found);
      actions.updateElements(
        live.current.slide.id,
        [...d.origin].map(([id, o]) => ({ id, patch: { x: Math.round(o.x + dx + sx), y: Math.round(o.y + dy + sy) } })),
      );
    } else if (d.kind === 'resize') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      let next = resizeBox(d.box, d.handle, dx, dy, { keepAspect: e.shiftKey && d.handle.length === 2 });
      let found: Guide[] = [];
      // Snapping an edge of a turned box would snap the wrong thing; turned boxes resize freely.
      if (!free && !d.box.rotation && d.handle.length === 2) {
        const snapped = snapResize(next, d.handle as 'nw' | 'ne' | 'sw' | 'se', targetsFor(new Set([d.id])), threshold, 24);
        next = { ...snapped.box, rotation: next.rotation };
        found = snapped.guides;
      }
      setGuides(found);
      actions.updateElements(live.current.slide.id, [
        { id: d.id, patch: { x: Math.round(next.x), y: Math.round(next.y), width: Math.round(next.width), height: Math.round(next.height) } },
      ]);
    } else if (d.kind === 'rotate') {
      const degrees = rotationToward(d.box, p, e.shiftKey ? 15 : 0);
      actions.updateElements(live.current.slide.id, [{ id: d.id, patch: { rotation: degrees === 0 ? undefined : degrees } }]);
    } else if (d.kind === 'marquee') {
      const rect = {
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        width: Math.abs(p.x - d.start.x),
        height: Math.abs(p.y - d.start.y),
      };
      if (rect.width * s < 4 && rect.height * s < 4) return;
      setMarquee(rect);
      const hit = new Set(d.base);
      for (const element of live.current.slide.elements) {
        const b = visibleBounds(element);
        if (b.x < rect.x + rect.width && b.x + b.width > rect.x && b.y < rect.y + rect.height && b.y + b.height > rect.y) hit.add(element.id);
      }
      onSelect(hit);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    setMarquee(null);
    if (page.current?.hasPointerCapture(e.pointerId)) page.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'move') {
      if (d.moved) actions.checkpoint();
      else if (d.collapseTo) onSelect(new Set([d.collapseTo]));
    } else if (d.kind === 'resize' || d.kind === 'rotate') actions.checkpoint();
  };

  const docContext = useMemo(() => ({ ydoc: session.ydoc, slideId: slide.id, actions }), [session.ydoc, slide.id, actions]);

  const only = useMemo(() => {
    const here = new Set(peers.filter((peer) => peer.slideId === slide.id).map((peer) => peer.clientId));
    return (clientId: number) => here.has(clientId);
  }, [peers, slide.id]);

  const single = canEdit && selectedIds.size === 1 && !editingId ? byId.get([...selectedIds][0]) : undefined;
  const selected = slide.elements.filter((element) => selectedIds.has(element.id));
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const handle = (coarse ? 22 : 10) / scale;
  const pageWidth = size.width * scale;
  const pageHeight = size.height * scale;

  return (
    <SlideDocContext.Provider value={docContext}>
    <div
      ref={frame}
      tabIndex={-1}
      data-slide-stage
      className="relative h-full w-full overflow-auto bg-[var(--color-surface)] outline-none"
      onPointerLeave={() => publishPointer(null)}
    >
      <div className="flex min-h-full min-w-full" style={{ width: pageWidth + MARGIN * 2, height: pageHeight + MARGIN * 2 }}>
        <div
          ref={page}
          className={cx('relative m-auto shrink-0 select-none shadow-lg ring-1 ring-black/10', canEdit ? 'touch-none' : '')}
          style={{ width: pageWidth, height: pageHeight, ...slideBackgroundStyle(slide, theme) }}
          onPointerDown={onPageDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          role="group"
          aria-label="Slide"
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          >
            {grid && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage: `linear-gradient(to right, rgba(120,120,140,.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(120,120,140,.28) 1px, transparent 1px)`,
                  backgroundSize: `${GRID}px ${GRID}px`,
                }}
              />
            )}

            <SlideFrameLayer slide={slide} theme={theme} />

            {slide.elements.map((element) => (
              <StageElement
                key={element.id}
                element={element}
                theme={theme}
                selected={selectedIds.has(element.id)}
                editing={editingId === element.id}
                canEdit={canEdit}
                members={members}
                onDown={onElementDown}
                onDoubleClick={(el) => canEdit && onEditing(el.id)}
                onUpdate={onUpdate}
                onStopEditing={() => onEditing(null)}
              />
            ))}

            {/* What other people have selected, in their color. */}
            {peers
              .filter((peer) => peer.slideId === slide.id)
              .flatMap((peer) =>
                peer.selected.map((id) => {
                  const element = byId.get(id);
                  return element ? (
                    <div
                      key={`${peer.clientId}:${id}`}
                      className="pointer-events-none absolute"
                      style={{ ...elementBoxStyle(element), outline: `${2 / scale}px solid ${peer.color}`, outlineOffset: 2 / scale }}
                    >
                      <span
                        className="absolute left-0 whitespace-nowrap rounded px-1 text-white"
                        style={{ background: peer.color, fontSize: 11 / scale, top: -18 / scale, lineHeight: 1.4 }}
                      >
                        {peer.name}
                      </span>
                    </div>
                  ) : null;
                }),
              )}

            {selected.map((element) => (
              <div
                key={element.id}
                className="pointer-events-none absolute"
                style={{ ...elementBoxStyle(element), outline: `${2 / scale}px solid var(--color-accent)` }}
              />
            ))}

            {single && (
              <div className="pointer-events-none absolute" style={elementBoxStyle(single)} data-selection-box>
                {RESIZE_HANDLES.map((h) => (
                  <HandleDot key={h} handle={h} size={handle} element={single} onDown={onHandleDown} />
                ))}
                <button
                  type="button"
                  aria-label="Rotate"
                  title="Rotate (hold Shift for 15 degree steps)"
                  className="pointer-events-auto absolute rounded-full border-2 border-[var(--color-accent)] bg-white"
                  style={{ width: handle, height: handle, left: `calc(50% - ${handle / 2}px)`, top: -handle * 2.6, cursor: 'grab' }}
                  onPointerDown={(e) => onHandleDown(e, single, 'rotate')}
                />
              </div>
            )}

            {guides.map((g, i) => (
              <div
                key={i}
                className="pointer-events-none absolute bg-fuchsia-500"
                style={
                  g.axis === 'x'
                    ? { left: g.at - 0.5 / scale, top: g.from, width: 1 / scale, height: g.to - g.from }
                    : { top: g.at - 0.5 / scale, left: g.from, height: 1 / scale, width: g.to - g.from }
                }
              />
            ))}

            {marquee && (
              <div
                className="pointer-events-none absolute border border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height, borderWidth: 1 / scale }}
              />
            )}
          </div>
          <PeerCursors session={session} viewport={{ x: 0, y: 0, scale }} only={only} />
        </div>
      </div>
    </div>
    </SlideDocContext.Provider>
  );
});

const StageElement = memo(function StageElement({
  element,
  theme,
  selected,
  editing,
  canEdit,
  members,
  onDown,
  onDoubleClick,
  onUpdate,
  onStopEditing,
}: {
  element: SlideElement;
  theme: Theme;
  selected: boolean;
  editing: boolean;
  canEdit: boolean;
  members: WorkspaceMember[];
  onDown: (e: React.PointerEvent, element: SlideElement) => void;
  onDoubleClick: (element: SlideElement) => void;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onStopEditing: () => void;
}) {
  const Renderer = slideElementRenderer(element.type);
  return (
    <div
      className="absolute"
      style={{ ...elementBoxStyle(element), cursor: canEdit && !editing ? 'move' : undefined }}
      data-element-id={element.id}
      onPointerDown={(e) => onDown(e, element)}
      onDoubleClick={() => onDoubleClick(element)}
    >
      <Renderer
        element={element}
        theme={theme}
        selected={selected}
        editing={editing}
        readOnly={false}
        members={members}
        onUpdate={onUpdate}
        onStopEditing={onStopEditing}
      />
    </div>
  );
});

function HandleDot({
  handle,
  size,
  element,
  onDown,
}: {
  handle: ResizeHandle;
  size: number;
  element: SlideElement;
  onDown: (e: React.PointerEvent, element: SlideElement, handle: ResizeHandle) => void;
}) {
  const x = handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50;
  const y = handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50;
  return (
    <button
      type="button"
      aria-label={`Resize from ${HANDLE_NAMES[handle]}`}
      className="pointer-events-auto absolute rounded-sm border-2 border-[var(--color-accent)] bg-white"
      style={{ width: size, height: size, left: `calc(${x}% - ${size / 2}px)`, top: `calc(${y}% - ${size / 2}px)`, cursor: CURSORS[handle] }}
      onPointerDown={(e) => onDown(e, element, handle)}
    />
  );
}
