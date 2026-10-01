import { useEffect, type ReactNode } from 'react';
import { cx } from '../lib/util';
import { Button } from './ui';

interface ModalProps {
  title: string;
  description?: string;
  children?: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  /** Wider panel, for dialogs with their own internal navigation. */
  wide?: boolean;
  /** Covers the whole screen, for a phone, where a floating panel leaves too little room to work in. */
  fullScreen?: boolean;
}

/** In-app dialog used wherever a window.confirm or window.prompt used to be. */
export function Modal({ title, description, children, footer, onClose, wide, fullScreen }: ModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={cx('fixed inset-0 z-50 flex items-center justify-center bg-black/50', !fullScreen && 'p-4')}
      onMouseDown={(e) => {
        // Only a click that starts on the backdrop itself closes, so a drag out
        // of a text field does not dismiss the dialog, and neither does a press
        // in a popover the dialog opened: those are portalled elsewhere in the
        // page but still bubble here through React.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'w-full bg-[var(--color-raised)] p-5',
          fullScreen
            ? 'flex h-full flex-col pt-[calc(1.25rem+env(safe-area-inset-top))] pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
            : cx('rounded-xl border border-[var(--color-line)] shadow-2xl', wide ? 'max-w-2xl' : 'max-w-sm'),
        )}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>}
        {children && <div className={cx('mt-3', fullScreen && 'flex min-h-0 flex-1 flex-col')}>{children}</div>}
        <div className="mt-5 flex shrink-0 justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Delete',
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      title={title}
      description={description}
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <button
            autoFocus
            onClick={onConfirm}
            className={
              destructive
                ? 'rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500'
                : 'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90'
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
