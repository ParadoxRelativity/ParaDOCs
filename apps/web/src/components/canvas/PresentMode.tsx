import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasElement, FrameElement } from '@paradocs/shared';
import CanvasElementView from './CanvasElementView';
import Connectors from './Connectors';
import Icon from '../Icon';

interface Props {
  frames: FrameElement[];
  elements: CanvasElement[];
  startIndex: number;
  dark: boolean;
  onExit: () => void;
  onOpenDocument: (documentId: string) => void;
}

/**
 * Presentation view: each frame becomes a slide, scaled to fit the screen.
 * Elements render read-only, so a presenter cannot nudge the board mid-pitch.
 */
export default function PresentMode({ frames, elements, startIndex, dark, onExit, onOpenDocument }: Props) {
  const [index, setIndex] = useState(startIndex);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const root = useRef<HTMLDivElement>(null);

  // Presenting must take focus. Without this the Present button keeps it, so
  // keystrokes are aimed at a control sitting behind the overlay and Escape
  // never reaches the presentation. Focus goes back where it came from on exit.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, frames.length - 1)), [frames.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onExit();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        next();
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        prev();
      }
    };
    // Capture phase, so the presentation claims these keys before the canvas
    // underneath can act on them.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, prev, onExit]);

  const frame = frames[index];
  if (!frame) {
    return (
      <div
        ref={root}
        tabIndex={-1}
        className="fixed inset-0 z-[70] grid place-items-center bg-black text-white outline-none"
      >
        <div className="text-center">
          <p className="text-sm">This canvas has no frames yet.</p>
          <p className="mt-1 text-xs opacity-70">Add a frame to define a slide, then present.</p>
          <button onClick={onExit} className="mt-4 rounded-md bg-white/15 px-3 py-1.5 text-xs">
            Close
          </button>
        </div>
      </div>
    );
  }

  // Fit the frame inside the viewport with a small margin.
  const margin = 48;
  const scale = Math.min(
    (size.width - margin * 2) / frame.width,
    (size.height - margin * 2) / frame.height,
  );
  const offsetX = (size.width - frame.width * scale) / 2 - frame.x * scale;
  const offsetY = (size.height - frame.height * scale) / 2 - frame.y * scale;

  // Everything that overlaps the frame travels with the slide.
  const visible = elements.filter((el) => {
    if (el.id === frame.id) return false;
    if (el.type === 'connector') return true;
    return (
      el.x < frame.x + frame.width &&
      el.x + el.width > frame.x &&
      el.y < frame.y + frame.height &&
      el.y + el.height > frame.y
    );
  });
  const byId = new Map(elements.map((el) => [el.id, el]));

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="fixed inset-0 z-[70] overflow-hidden bg-[var(--color-canvas)] outline-none"
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})` }}
      >
        <Connectors
          connectors={visible.filter((el) => el.type === 'connector') as never}
          byId={byId}
          selectedIds={new Set()}
          onSelect={() => {}}
          mindEdges={elements
            .filter((el) => el.type === 'node' && el.parentId && byId.has(el.parentId))
            .map((el) => ({
              from: byId.get((el as { parentId?: string }).parentId!)!,
              to: el,
              color: el.color ?? '#6366f1',
            }))}
          scale={scale}
          editable={false}
          onRouteHandleDown={() => {}}
        />
        {visible
          .filter((el) => el.type !== 'connector')
          .map((element) => (
            <div
              key={element.id}
              className="absolute"
              style={{ left: element.x, top: element.y, width: element.width, height: element.height }}
            >
              <CanvasElementView
                element={element}
                selected={false}
                editing={false}
                dark={dark}
                onChange={() => {}}
                onStopEditing={() => {}}
                onOpenDocument={onOpenDocument}
              />
            </div>
          ))}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/50 to-transparent px-5 py-4 text-white">
        <span className="truncate text-sm font-medium">{frame.name || `Frame ${index + 1}`}</span>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <button onClick={prev} disabled={index === 0} className="rounded bg-white/15 px-2 py-1 disabled:opacity-40">
            <Icon name="chevron-left" /> Prev
          </button>
          <span className="tabular-nums">
            {index + 1} / {frames.length}
          </span>
          <button
            onClick={next}
            disabled={index === frames.length - 1}
            className="rounded bg-white/15 px-2 py-1 disabled:opacity-40"
          >
            Next <Icon name="chevron-right" />
          </button>
          <button onClick={onExit} className="ml-2 rounded bg-white/15 px-2 py-1">
            Exit (esc)
          </button>
        </div>
      </div>
    </div>
  );
}
