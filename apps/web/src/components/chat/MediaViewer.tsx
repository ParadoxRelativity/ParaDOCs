import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icon';

export interface ViewerItem {
  url: string;
  filename: string;
  kind: 'image' | 'video';
}

/**
 * Full-window view of the pictures and videos in a message, with the arrow
 * keys moving between them.
 */
export function MediaViewer({
  items,
  index,
  onStep,
  onClose,
}: {
  items: ViewerItem[];
  index: number;
  /** Moves by this many items, wrapping at either end. */
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const count = items.length;
  const item = items[index];

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      // A focused video uses the arrow keys to seek.
      if (count < 2 || (e.target as HTMLElement | null)?.tagName === 'VIDEO') return;
      if (e.key === 'ArrowRight') onStep(1);
      if (e.key === 'ArrowLeft') onStep(-1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count, onStep, onClose]);

  if (!item) return null;

  const closeOnBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.filename}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
      onMouseDown={closeOnBackdrop}
    >
      <div className="flex h-12 shrink-0 items-center gap-3 px-4">
        <span className="min-w-0 flex-1 truncate text-sm">{item.filename}</span>
        {count > 1 && (
          <span className="shrink-0 text-xs text-white/60">
            {index + 1} of {count}
          </span>
        )}
        <a
          href={item.url}
          download={item.filename}
          title="Download"
          aria-label={`Download ${item.filename}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-white/10"
        >
          <Icon name="download" />
        </a>
        <button
          ref={closeButton}
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-white/10"
        >
          <Icon name="x-lg" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-8" onMouseDown={closeOnBackdrop}>
        {item.kind === 'image' ? (
          <img key={item.url} src={item.url} alt={item.filename} className="max-h-full max-w-full object-contain" />
        ) : (
          <video key={item.url} src={item.url} controls autoPlay className="max-h-full max-w-full" />
        )}

        {count > 1 && (
          <>
            <button
              onClick={() => onStep(-1)}
              aria-label="Previous"
              className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 hover:bg-white/20"
            >
              <Icon name="chevron-left" />
            </button>
            <button
              onClick={() => onStep(1)}
              aria-label="Next"
              className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 hover:bg-white/20"
            >
              <Icon name="chevron-right" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
