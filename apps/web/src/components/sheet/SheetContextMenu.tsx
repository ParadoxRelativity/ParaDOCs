import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/util';
import Icon, { type IconName } from '../Icon';

export type SheetMenuItem =
  | { label: string; icon?: IconName; danger?: boolean; onSelect: () => void }
  | 'divider';

/**
 * The menu a right-click on the grid opens, at the pointer. Any press outside
 * it, Escape, or scrolling the grid out from under it closes it.
 */
export default function SheetContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: SheetMenuItem[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const margin = 8;
    setPosition({
      left: Math.min(x, window.innerWidth - element.offsetWidth - margin),
      top: Math.min(y, window.innerHeight - element.offsetHeight - margin),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close.current();
    };
    const onBlur = () => close.current();
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[69]"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={panel}
        role="menu"
        className="fixed z-[70] min-w-52 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 text-xs shadow-xl"
        style={{ left: position?.left ?? x, top: position?.top ?? y, visibility: position ? 'visible' : 'hidden' }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {items.map((item, index) =>
          item === 'divider' ? (
            <div key={`divider-${index}`} className="my-1 h-px bg-[var(--color-line)]" />
          ) : (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface)]',
                item.danger && 'text-red-500',
              )}
            >
              <span className="grid w-4 place-items-center text-[var(--color-muted)]">
                {item.icon && <Icon name={item.icon} className={item.danger ? 'text-red-500' : undefined} />}
              </span>
              {item.label}
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  );
}
