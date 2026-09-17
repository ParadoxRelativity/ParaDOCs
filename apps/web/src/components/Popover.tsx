import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/util';

/**
 * A floating panel attached to the control that opened it: a person's card
 * beside the member list, the status menu above your name. Escape or a press
 * anywhere else closes it; pressing the control itself is left to the control,
 * which toggles.
 *
 * Rendered in a portal so a scrolling list cannot clip it, and kept on screen
 * once its real size is known.
 */
export function Popover({
  anchor,
  placement,
  onClose,
  className,
  children,
}: {
  anchor: HTMLElement;
  /** Beside the control, to its left, above it, or under it. */
  placement: 'left' | 'above' | 'below';
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = placement === 'left' ? rect.left - width - margin : rect.left;
    const top =
      placement === 'left'
        ? rect.top
        : placement === 'below'
          ? rect.bottom + margin
          : rect.top - height - margin;
    setPosition({
      left: Math.min(Math.max(left, margin), window.innerWidth - width - margin),
      top: Math.min(Math.max(top, margin), window.innerHeight - height - margin),
    });
  }, [anchor, placement]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes only the popover, not a dialog it was opened from.
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      className={cx(
        'fixed z-[70] rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] shadow-2xl',
        className,
      )}
      // Measured before it is shown, so it never flashes in the corner.
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
