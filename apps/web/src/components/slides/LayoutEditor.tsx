import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  PLACEHOLDER_KIND_LABELS,
  SLIDE_FONTS,
  addLayout,
  deleteLayout,
  fontStack,
  isChromeKind,
  newPlaceholder,
  patchPlaceholder,
  resolveLayoutPlaceholders,
  resolveSlideColor,
  updateLayout,
  updateMaster,
  type LayoutPlaceholder,
  type MasterPlaceholder,
  type PlaceholderKind,
  type PlaceholderPatch,
  type PlaceholderStyle,
  type ResolvedPlaceholder,
  type SlideBackground,
  type SlideFrame,
  type SlideLayout,
} from '@paradocs/shared';
import { useBackHandler } from '../../lib/back';
import { useIsMobile } from '../../lib/mobile';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Button, IconButton } from '../ui';
import BackgroundEditor, { ThemeColorPicker, uploadPicture } from './BackgroundEditor';
import { Field, NumberInput, SelectInput, ToolButton } from './inspectorParts';
import type { SlideEditorContext } from './slideExtensions';
import { SlideFrameLayer, backgroundStyle } from './SlideView';

const MASTER = 'master';
const MIN_BOX = 20;
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Handle, string> = { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const ADDABLE: PlaceholderKind[] = ['title', 'subtitle', 'body', 'image', 'footer', 'slideNumber', 'date'];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * "Edit layouts": the master and each layout of the deck, drawn as a slide of
 * placeholder boxes to drag and resize, with their text style, prompt and
 * background beside them. Whatever is changed here applies at once to every
 * slide using that layout, except properties a slide has overridden. Full
 * screen, with the controls under the slide on a phone.
 */
export default function LayoutEditor({ ctx, onClose }: { ctx: SlideEditorContext; onClose: () => void }) {
  const { deck, canEdit, actions, theme } = ctx;
  const mobile = useIsMobile();
  const { size } = deck.settings;
  const [targetId, setTargetId] = useState<string>(ctx.slide?.layoutId ?? MASTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useBackHandler(() => (selectedId ? setSelectedId(null) : onClose()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest?.('input, select, textarea')) return;
      e.stopPropagation();
      if (selectedId) setSelectedId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onClose]);

  const isMaster = targetId === MASTER;
  const layout: SlideLayout | undefined = isMaster ? undefined : deck.layouts.find((l) => l.id === targetId);
  // A layout that was deleted (here or by someone else) falls back to the master.
  useEffect(() => {
    if (!isMaster && !layout) setTargetId(MASTER);
  }, [isMaster, layout]);
  useEffect(() => setSelectedId(null), [targetId]);

  const resolved: ResolvedPlaceholder[] = isMaster
    ? deck.master.placeholders.map((p) => ({ ...p, style: p.style ?? {}, prompt: p.prompt ?? '' }))
    : layout
      ? resolveLayoutPlaceholders(layout, deck.master)
      : [];
  const own = (id: string): LayoutPlaceholder | MasterPlaceholder | undefined =>
    (isMaster ? deck.master.placeholders : layout?.placeholders)?.find((p) => p.id === id);
  const selected = resolved.find((p) => p.id === selectedId) ?? null;

  /** Writes a placeholder change to the master or the layout being edited. */
  const patch = (id: string, change: PlaceholderPatch) => {
    if (!canEdit) return;
    if (isMaster) actions.edit((doc) => updateMaster(doc, { placeholders: patchPlaceholder(deck.master.placeholders, id, change) }));
    else if (layout) actions.edit((doc) => updateLayout(doc, layout.id, { placeholders: patchPlaceholder(layout.placeholders, id, change) }));
  };
  const style = (id: string, change: PlaceholderPatch['style']) => patch(id, { style: change });

  const setPlaceholders = (placeholders: LayoutPlaceholder[]) => {
    if (!canEdit) return;
    if (isMaster) actions.edit((doc) => updateMaster(doc, { placeholders: placeholders as MasterPlaceholder[] }));
    else if (layout) actions.edit((doc) => updateLayout(doc, layout.id, { placeholders }));
  };
  const addPlaceholder = (kind: PlaceholderKind) => {
    const ids = (isMaster ? deck.master.placeholders : (layout?.placeholders ?? [])).map((p) => p.id);
    let fresh = newPlaceholder(kind, ids, size);
    // The master's placeholders always carry a box of their own.
    if (isMaster && fresh.x === undefined) {
      const base = deck.master.placeholders.find((p) => p.kind === kind);
      fresh = { ...fresh, x: base?.x ?? 120, y: base?.y ?? 1000, width: base?.width ?? 400, height: base?.height ?? 50 };
    }
    setPlaceholders([...(isMaster ? deck.master.placeholders : (layout?.placeholders ?? [])), fresh]);
    setSelectedId(fresh.id);
  };
  const removePlaceholder = (id: string) => {
    setPlaceholders((isMaster ? deck.master.placeholders : (layout?.placeholders ?? [])).filter((p) => p.id !== id));
    setSelectedId(null);
  };

  const background = isMaster ? deck.master.background : (layout?.background ?? null);
  const frame: SlideFrame = {
    background: background ?? deck.master.background,
    elements: [...(layout?.hideMasterElements ? [] : deck.master.elements), ...(layout?.elements ?? [])],
    chrome: [],
  };

  const preview = (
    <Preview
      size={size}
      frame={frame}
      theme={theme}
      placeholders={resolved}
      selectedId={selectedId}
      canEdit={canEdit}
      onSelect={setSelectedId}
      onCommit={(id, box) => patch(id, box)}
    />
  );

  const panel = (
    <div className="scroll-thin space-y-4 overflow-y-auto p-3 text-sm">
      {layout && (
        <section className="space-y-2">
          <label className="block">
            <span className="text-xs text-[var(--color-muted)]">Layout name</span>
            <input
              key={layout.id + layout.name}
              defaultValue={layout.name}
              disabled={!canEdit}
              onBlur={(e) => e.target.value.trim() && e.target.value !== layout.name && actions.edit((doc) => updateLayout(doc, layout.id, { name: e.target.value.trim() }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                e.stopPropagation();
              }}
              className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <div className="flex flex-wrap gap-1">
            <Button
              variant="subtle"
              className="!px-2 !py-1 text-xs"
              disabled={!canEdit}
              onClick={() => {
                let id = '';
                actions.edit((doc) => void (id = addLayout(doc, `${layout.name} copy`, layout.id)));
                setTargetId(id);
              }}
            >
              Duplicate
            </Button>
            <Button
              variant="danger"
              className="!px-2 !py-1 text-xs"
              disabled={!canEdit || deck.layouts.length < 2}
              onClick={() => {
                const used = ctx.slides.filter((s) => s.layoutId === layout.id).length;
                if (used && !window.confirm(`${used} slide${used === 1 ? '' : 's'} use this layout and will move to the blank layout. Delete it?`)) return;
                actions.edit((doc) => void deleteLayout(doc, layout.id));
              }}
            >
              Delete
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Background</h3>
        <BackgroundEditor
          value={background}
          theme={theme}
          disabled={!canEdit}
          inheritLabel={isMaster ? undefined : 'Same as master'}
          onChange={(next: SlideBackground | null) => {
            if (isMaster && next) actions.edit((doc) => updateMaster(doc, { background: next }));
            else if (layout) actions.edit((doc) => updateLayout(doc, layout.id, { background: next }));
          }}
          upload={uploadPicture(ctx)}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Placeholders</h3>
          <SelectInput<PlaceholderKind>
            label="Add placeholder"
            value=""
            disabled={!canEdit}
            options={[{ value: '', label: 'Add...' }, ...ADDABLE.map((kind) => ({ value: kind, label: PLACEHOLDER_KIND_LABELS[kind] }))]}
            onChange={(kind) => kind && addPlaceholder(kind)}
          />
        </div>
        <ul className="space-y-1">
          {resolved.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                aria-pressed={p.id === selectedId}
                className={cx(
                  'flex w-full items-center justify-between rounded px-2 py-2 text-left sm:py-1',
                  p.id === selectedId ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'hover:bg-[var(--color-surface)]',
                )}
              >
                <span>{PLACEHOLDER_KIND_LABELS[p.kind]}</span>
                <span className="text-xs text-[var(--color-muted)]">{p.id}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <PlaceholderProperties
          key={selected.id}
          ctx={ctx}
          placeholder={selected}
          own={own(selected.id)}
          inherits={!isMaster}
          onPatch={(change) => patch(selected.id, change)}
          onStyle={(change) => style(selected.id, change)}
          onRemove={() => removePlaceholder(selected.id)}
        />
      )}
    </div>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="Edit layouts" className="fixed inset-0 z-50 flex flex-col bg-[var(--color-canvas)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <IconButton label="Done editing layouts" onClick={onClose}>
          <Icon name="chevron-left" />
        </IconButton>
        <h2 className="text-sm font-semibold">Edit layouts</h2>
        {!canEdit && <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">View only</span>}
        <Button variant="primary" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>

      <div className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-line)] px-2 py-1.5" role="tablist" aria-label="Master and layouts">
        {[{ id: MASTER, name: 'Master' }, ...deck.layouts].map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === targetId}
            onClick={() => setTargetId(entry.id)}
            className={cx(
              'shrink-0 rounded-full border px-3 py-1.5 text-sm sm:py-1',
              entry.id === targetId ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
            )}
          >
            {entry.name}
          </button>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              let id = '';
              actions.edit((doc) => void (id = addLayout(doc, 'New layout')));
              setTargetId(id);
            }}
            className="shrink-0 rounded-full border border-dashed border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-muted)] sm:py-1"
          >
            <Icon name="plus-lg" /> Layout
          </button>
        )}
      </div>

      <div className={cx('flex min-h-0 flex-1', mobile ? 'flex-col' : 'flex-row')}>
        <div className={cx('min-h-0 min-w-0 bg-[var(--color-surface)]', mobile ? 'shrink-0 p-2' : 'flex-1 p-4')}>{preview}</div>
        <div className={cx('min-h-0 border-[var(--color-line)] bg-[var(--color-canvas)]', mobile ? 'flex-1 border-t' : 'w-80 shrink-0 border-l')}>{panel}</div>
      </div>
    </div>
  );
}

/** The slide, scaled to its container, with a draggable box for each placeholder. */
function Preview({
  size,
  frame,
  theme,
  placeholders,
  selectedId,
  canEdit,
  onSelect,
  onCommit,
}: {
  size: { width: number; height: number };
  frame: SlideFrame;
  theme: SlideEditorContext['theme'];
  placeholders: ResolvedPlaceholder[];
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (id: string | null) => void;
  onCommit: (id: string, box: Box) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ id: string; box: Box } | null>(null);
  const op = useRef<{ id: string; handle: Handle; startX: number; startY: number; origin: Box } | null>(null);

  useLayoutEffect(() => {
    const el = holder.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale = width > 0 ? width / size.width : 0;
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const grip = (coarse ? 26 : 12) / Math.max(scale, 0.01);

  const start = (e: ReactPointerEvent, p: ResolvedPlaceholder, handle: Handle) => {
    e.stopPropagation();
    onSelect(p.id);
    if (!canEdit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    op.current = { id: p.id, handle, startX: e.clientX, startY: e.clientY, origin: { x: p.x, y: p.y, width: p.width, height: p.height } };
  };
  const move = (e: ReactPointerEvent) => {
    const o = op.current;
    if (!o || scale <= 0) return;
    const dx = (e.clientX - o.startX) / scale;
    const dy = (e.clientY - o.startY) / scale;
    let { x, y, width: w, height: h } = o.origin;
    if (o.handle === 'move') {
      x += dx;
      y += dy;
    } else {
      if (o.handle.includes('e')) w = Math.max(MIN_BOX, w + dx);
      if (o.handle.includes('s')) h = Math.max(MIN_BOX, h + dy);
      if (o.handle.includes('w')) {
        const nw = Math.max(MIN_BOX, w - dx);
        x += w - nw;
        w = nw;
      }
      if (o.handle.includes('n')) {
        const nh = Math.max(MIN_BOX, h - dy);
        y += h - nh;
        h = nh;
      }
    }
    setDrag({ id: o.id, box: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) } });
  };
  const end = () => {
    const o = op.current;
    op.current = null;
    const current = drag;
    setDrag(null);
    if (!o || !current || current.id !== o.id) return;
    const { x, y, width: w, height: h } = current.box;
    if (x !== o.origin.x || y !== o.origin.y || w !== o.origin.width || h !== o.origin.height) onCommit(o.id, current.box);
  };

  return (
    <div ref={holder} className="w-full" style={{ maxWidth: '100%' }}>
      <div
        className="relative mx-auto overflow-hidden shadow-lg ring-1 ring-black/10"
        style={{ width, height: width * (size.height / size.width), ...backgroundStyle(frame.background, theme), touchAction: 'none' }}
        onPointerDown={() => onSelect(null)}
        role="group"
        aria-label="Layout preview"
      >
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>
          <SlideFrameLayer slide={{ frame }} theme={theme} />
          {placeholders.map((p) => {
            const box = drag?.id === p.id ? drag.box : p;
            const active = p.id === selectedId;
            const s = p.style;
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                aria-label={`${PLACEHOLDER_KIND_LABELS[p.kind]} placeholder`}
                aria-pressed={active}
                onPointerDown={(e) => start(e, p, 'move')}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(p.id);
                  if (!canEdit || !active || !e.key.startsWith('Arrow')) return;
                  e.preventDefault();
                  const d = e.shiftKey ? 10 : 1;
                  onCommit(p.id, { ...p, x: p.x + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), y: p.y + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0) });
                }}
                className="absolute"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  cursor: canEdit ? CURSORS.move : 'pointer',
                  outline: `${(active ? 3 : 2) / Math.max(scale, 0.01)}px ${active ? 'solid' : 'dashed'} ${active ? 'var(--color-accent)' : 'rgba(120,120,140,.7)'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: s.verticalAlign === 'bottom' ? 'flex-end' : s.verticalAlign === 'middle' ? 'center' : 'flex-start',
                  padding: 12,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  fontFamily: fontStack(s.fontFamily ?? (p.kind === 'title' ? theme.fonts.heading : theme.fonts.body)),
                  fontSize: s.fontSize ?? 32,
                  fontWeight: s.bold ? 700 : 400,
                  fontStyle: s.italic ? 'italic' : 'normal',
                  textAlign: s.align ?? 'left',
                  color: resolveSlideColor(s.color ?? 'theme:text1', theme),
                  background: s.fill ? resolveSlideColor(s.fill, theme) : p.kind === 'image' ? 'rgba(120,120,140,.15)' : undefined,
                  opacity: 0.85,
                }}
              >
                {p.kind === 'image' ? <span style={{ textAlign: 'center', fontSize: 28 }}>{p.prompt}</span> : p.prompt}
                {active &&
                  canEdit &&
                  HANDLES.map((h) => (
                    <span
                      key={h}
                      onPointerDown={(e) => start(e, p, h)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={end}
                      className="absolute rounded-sm border border-[var(--color-accent)] bg-white"
                      style={{
                        width: grip,
                        height: grip,
                        cursor: CURSORS[h],
                        left: h.includes('w') ? -grip / 2 : h.includes('e') ? undefined : `calc(50% - ${grip / 2}px)`,
                        right: h.includes('e') ? -grip / 2 : undefined,
                        top: h.includes('n') ? -grip / 2 : h.includes('s') ? undefined : `calc(50% - ${grip / 2}px)`,
                        bottom: h.includes('s') ? -grip / 2 : undefined,
                      }}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </div>
      {width > 0 && placeholders.length === 0 && <p className="mt-2 text-center text-xs text-[var(--color-muted)]">No placeholders. Add one from the list.</p>}
    </div>
  );
}

function PlaceholderProperties({
  ctx,
  placeholder,
  own,
  inherits,
  onPatch,
  onStyle,
  onRemove,
}: {
  ctx: SlideEditorContext;
  placeholder: ResolvedPlaceholder;
  own: LayoutPlaceholder | MasterPlaceholder | undefined;
  /** A layout's placeholder: fields can be forgotten to follow the master again. */
  inherits: boolean;
  onPatch: (change: PlaceholderPatch) => void;
  onStyle: (change: PlaceholderPatch['style']) => void;
  onRemove: () => void;
}) {
  const { canEdit, theme } = ctx;
  const chrome = isChromeKind(placeholder.kind);
  const s: PlaceholderStyle = placeholder.style;
  const overrides = inherits && own !== undefined && ('x' in own || 'y' in own || 'width' in own || 'height' in own || 'prompt' in own || Boolean(own.style && Object.keys(own.style).length));
  const fonts = [{ value: '', label: 'Theme font' }, ...SLIDE_FONTS.map((f) => ({ value: f.family, label: f.family }))];
  return (
    <section className="space-y-2 border-t border-[var(--color-line)] pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{PLACEHOLDER_KIND_LABELS[placeholder.kind]} placeholder</h3>
      <div className="grid grid-cols-2 gap-2">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label key={key} className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-xs text-[var(--color-muted)]">{key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'W' : 'H'}</span>
            <NumberInput label={key} value={placeholder[key]} min={key === 'width' || key === 'height' ? MIN_BOX : undefined} disabled={!canEdit} onCommit={(value) => onPatch({ [key]: Math.round(value) })} />
          </label>
        ))}
      </div>

      {!chrome && (
        <label className="block">
          <span className="text-xs text-[var(--color-muted)]">Prompt text</span>
          <input
            key={placeholder.id + placeholder.prompt}
            defaultValue={placeholder.prompt}
            disabled={!canEdit}
            onBlur={(e) => e.target.value !== placeholder.prompt && onPatch({ prompt: e.target.value || null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              e.stopPropagation();
            }}
            className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      )}

      {placeholder.kind !== 'image' && (
        <>
          <Field label="Font">
            <SelectInput label="Font" value={s.fontFamily ?? ''} options={fonts} disabled={!canEdit} onChange={(family) => onStyle({ fontFamily: family || null })} />
          </Field>
          <Field label="Size">
            <NumberInput label="Font size" value={s.fontSize} min={6} max={400} disabled={!canEdit} onCommit={(fontSize) => onStyle({ fontSize: Math.round(fontSize) })} />
          </Field>
          <div className="flex flex-wrap items-center gap-1">
            <ToolButton label="Bold" icon="type-bold" active={s.bold === true} disabled={!canEdit} onClick={() => onStyle({ bold: s.bold ? null : true })} />
            <ToolButton label="Italic" icon="type-italic" active={s.italic === true} disabled={!canEdit} onClick={() => onStyle({ italic: s.italic ? null : true })} />
            <ToolButton label="Align left" icon="text-left" active={(s.align ?? 'left') === 'left'} disabled={!canEdit} onClick={() => onStyle({ align: 'left' })} />
            <ToolButton label="Align center" icon="text-center" active={s.align === 'center'} disabled={!canEdit} onClick={() => onStyle({ align: 'center' })} />
            <ToolButton label="Align right" icon="text-right" active={s.align === 'right'} disabled={!canEdit} onClick={() => onStyle({ align: 'right' })} />
          </div>
          <Field label="Vertical">
            <SelectInput<'top' | 'middle' | 'bottom'>
              label="Vertical alignment"
              value={s.verticalAlign ?? 'top'}
              options={[
                { value: 'top', label: 'Top' },
                { value: 'middle', label: 'Middle' },
                { value: 'bottom', label: 'Bottom' },
              ]}
              disabled={!canEdit}
              onChange={(verticalAlign) => verticalAlign && onStyle({ verticalAlign })}
            />
          </Field>
          <div className="space-y-1">
            <span className="text-xs text-[var(--color-muted)]">Text color</span>
            <ThemeColorPicker label="Text color" value={s.color} theme={theme} disabled={!canEdit} onChange={(color) => onStyle({ color })} />
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-1 pt-1">
        {overrides && (
          <Button
            variant="subtle"
            className="!px-2 !py-1 text-xs"
            disabled={!canEdit}
            onClick={() => onPatch({ x: null, y: null, width: null, height: null, prompt: null, style: Object.fromEntries(Object.keys(own?.style ?? {}).map((k) => [k, null])) })}
          >
            Inherit from master
          </Button>
        )}
        <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={!canEdit} onClick={onRemove}>
          Remove placeholder
        </Button>
      </div>
    </section>
  );
}
