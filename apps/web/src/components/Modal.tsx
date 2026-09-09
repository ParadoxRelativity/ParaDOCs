import { useEffect, useRef, type ReactNode } from 'react';
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
}

/** In-app dialog used wherever a window.confirm or window.prompt used to be. */
export function Modal({ title, description, children, footer, onClose, wide }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        // Only a click that starts on the backdrop closes, so a drag out of a
        // text field does not dismiss the dialog.
        if (!panel.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-5 shadow-2xl',
          wide ? 'max-w-2xl' : 'max-w-sm',
        )}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>}
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
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
