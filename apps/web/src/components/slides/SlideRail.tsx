import { useEffect, useRef, useState } from 'react';
import type { SlideSize, SlideSnapshot, Theme } from '@paradocs/shared';
import type { PeerSlideState } from '../../lib/slidesPresence';
import { cx } from '../../lib/util';
import { IconButton } from '../ui';
import Icon from '../Icon';
import SlideView from './SlideView';

interface Props {
  slides: SlideSnapshot[];
  size: SlideSize;
  theme: Theme;
  currentId: string | null;
  /** Slides selected for a bulk action; always contains the current one. */
  selection: Set<string>;
  canEdit: boolean;
  /** Along the bottom of the screen on a phone, down the left side otherwise. */
  horizontal: boolean;
  peers: PeerSlideState[];
  onOpen: (id: string, mode: 'replace' | 'toggle' | 'range') => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleHidden: () => void;
  onMove: (toIndex: number) => void;
}

/** A drag that is moving slides: where it would drop is an index among the slides that stay. */
type DropAt = { index: number } | null;

/**
 * The slide rail: every slide as a read-only thumbnail, in running order.
 * Click to open, shift or ctrl/cmd to select several, drag to reorder; the
 * buttons do the same for keyboards and touch screens, where dragging is
 * awkward.
 */
export default function SlideRail({
  slides,
  size,
  theme,
  currentId,
  selection,
  canEdit,
  horizontal,
  peers,
  onOpen,
  onAdd,
  onDuplicate,
  onDelete,
  onToggleHidden,
  onMove,
}: Props) {
  const [dropAt, setDropAt] = useState<DropAt>(null);
  const dragging = useRef<string[] | null>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const thumbWidth = horizontal ? 112 : 176;

  // Keep the open slide in view as it changes (arrow keys, a remote delete).
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentId]);

  const indexOfCurrent = slides.findIndex((slide) => slide.id === currentId);
  const allHidden = [...selection].every((id) => slides.find((s) => s.id === id)?.hidden);

  /** The drop position among the slides that are not moving, from the pointer over a thumbnail. */
  const dropIndex = (e: React.DragEvent, over: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const after = horizontal ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2;
    const moving = dragging.current ?? [];
    const at = after ? over + 1 : over;
    // Counted among the slides that stay, as moveSlides expects.
    return slides.slice(0, at).filter((s) => !moving.includes(s.id)).length;
  };

  return (
    <div className={cx('flex min-h-0 min-w-0 bg-[var(--color-canvas)]', horizontal ? 'h-[104px] w-full flex-row border-t' : 'h-full w-52 flex-col border-r', 'border-[var(--color-line)]')}>
      {canEdit && (
        <div className={cx('flex shrink-0 gap-0.5 p-1', horizontal ? 'flex-col justify-center border-r border-[var(--color-line)]' : 'flex-wrap border-b border-[var(--color-line)]')}>
          <IconButton label="New slide (Ctrl+M)" onClick={onAdd}>
            <Icon name="plus-lg" />
          </IconButton>
          <IconButton label="Duplicate slide" onClick={onDuplicate} disabled={selection.size === 0}>
            <Icon name="copy" />
          </IconButton>
          <IconButton label={allHidden ? 'Show slide in the slideshow' : 'Hide slide from the slideshow'} onClick={onToggleHidden} disabled={selection.size === 0}>
            <Icon name={allHidden ? 'eye' : 'eye-slash'} />
          </IconButton>
          <IconButton
            label="Move slide earlier"
            onClick={() => onMove(Math.max(0, Math.min(...[...selection].map((id) => slides.findIndex((s) => s.id === id))) - 1))}
            disabled={selection.size === 0 || slides[0] === undefined || selection.has(slides[0].id)}
          >
            <Icon name={horizontal ? 'chevron-left' : 'chevron-up'} />
          </IconButton>
          <IconButton
            label="Move slide later"
            onClick={() => onMove(Math.min(...[...selection].map((id) => slides.findIndex((s) => s.id === id))) + 1)}
            disabled={selection.size === 0 || slides.length === 0 || selection.has(slides[slides.length - 1].id)}
          >
            <Icon name={horizontal ? 'chevron-right' : 'chevron-down'} />
          </IconButton>
          <IconButton label="Delete slide (Delete)" onClick={onDelete} disabled={selection.size === 0} className="hover:text-red-500">
            <Icon name="trash" />
          </IconButton>
        </div>
      )}

      <ol
        aria-label="Slides"
        className={cx('scroll-thin flex min-h-0 min-w-0 flex-1 gap-2 p-2', horizontal ? 'flex-row overflow-x-auto' : 'flex-col overflow-y-auto')}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
      >
        {slides.map((slide, index) => {
          const current = slide.id === currentId;
          const selected = selection.has(slide.id);
          const here = peers.filter((peer) => peer.slideId === slide.id);
          const showBefore = dropAt && dragging.current && dropIndexBefore(slides, dragging.current, dropAt.index) === index;
          return (
            <li
              key={slide.id}
              ref={current ? currentRef : undefined}
              className={cx('relative flex shrink-0 gap-1.5', horizontal ? 'flex-col items-center' : 'flex-row items-start')}
              draggable={canEdit}
              onDragStart={(e) => {
                // Dragging a slide that is part of the selection takes the whole selection.
                dragging.current = selected ? slides.filter((s) => selection.has(s.id)).map((s) => s.id) : [slide.id];
                if (!selected) onOpen(slide.id, 'replace');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', slide.id);
              }}
              onDragOver={(e) => {
                if (!dragging.current) return;
                e.preventDefault();
                setDropAt({ index: dropIndex(e, index) });
              }}
              onDrop={(e) => {
                if (!dragging.current) return;
                e.preventDefault();
                const to = dropIndex(e, index);
                const ids = dragging.current;
                dragging.current = null;
                setDropAt(null);
                // The moved slides are the selection by now, so move reads from it.
                if (ids.length) onMove(to);
              }}
              onDragEnd={() => {
                dragging.current = null;
                setDropAt(null);
              }}
            >
              {showBefore && <DropMarker horizontal={horizontal} />}
              <span className="w-4 shrink-0 pt-1 text-right text-[11px] tabular-nums text-[var(--color-muted)]">{index + 1}</span>
              <button
                type="button"
                aria-label={`Slide ${index + 1}${slide.hidden ? ' (hidden)' : ''}`}
                aria-current={current ? 'true' : undefined}
                onClick={(e) => onOpen(slide.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')}
                className={cx(
                  'relative block overflow-hidden rounded-md outline-none ring-2 focus-visible:ring-[var(--color-accent)]',
                  current ? 'ring-[var(--color-accent)]' : selected ? 'ring-[var(--color-accent)]/50' : 'ring-[var(--color-line)] hover:ring-[var(--color-muted)]',
                )}
              >
                <SlideView slide={slide} size={size} theme={theme} width={thumbWidth} />
                {slide.hidden && (
                  <span className="absolute inset-0 grid place-items-center bg-black/40 text-white">
                    <Icon name="eye-slash" />
                  </span>
                )}
                {here.length > 0 && (
                  <span className="absolute right-1 top-1 flex gap-0.5">
                    {here.map((peer) => (
                      <span key={peer.clientId} title={peer.name} className="h-2.5 w-2.5 rounded-full ring-1 ring-white" style={{ background: peer.color }} />
                    ))}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {dropAt && dragging.current && dropIndexBefore(slides, dragging.current, dropAt.index) === slides.length && <DropMarker horizontal={horizontal} />}
        {slides.length === 0 && (
          <li className="px-2 py-4 text-center text-xs text-[var(--color-muted)]">{canEdit ? 'No slides yet. Add one with +.' : 'No slides yet.'}</li>
        )}
      </ol>
      <span className="sr-only" aria-live="polite">
        {indexOfCurrent >= 0 ? `Slide ${indexOfCurrent + 1} of ${slides.length}` : ''}
      </span>
    </div>
  );
}

/** Which slide's position the drop marker sits before, given a drop index counted among the slides that stay. */
function dropIndexBefore(slides: SlideSnapshot[], moving: string[], dropIndex: number): number {
  let stay = 0;
  for (let i = 0; i < slides.length; i++) {
    if (moving.includes(slides[i].id)) continue;
    if (stay === dropIndex) return i;
    stay++;
  }
  return slides.length;
}

function DropMarker({ horizontal }: { horizontal: boolean }) {
  return (
    <span
      aria-hidden
      className={cx('pointer-events-none absolute rounded bg-[var(--color-accent)]', horizontal ? '-left-1.5 top-0 h-full w-0.5' : '-top-1.5 left-0 h-0.5 w-full')}
    />
  );
}
