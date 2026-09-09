import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/util';

export type ToastTone = 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

type PushToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<PushToast>(() => {});

/** Transient confirmations, replacing the feedback a browser dialog used to give. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const push = useCallback<PushToast>((message, tone = 'success') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    // Errors linger, since they usually need reading.
    const timer = setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, tone === 'error' ? 7000 : 3500);
    timers.current.push(timer);
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Above modals, which sit at z-50. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cx(
              'pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg',
              'animate-[paradocs-toast_180ms_ease-out]',
              toast.tone === 'error'
                ? 'border-red-500/40 bg-red-500/10 text-red-500'
                : 'border-[var(--color-line)] bg-[var(--color-raised)] text-[var(--color-ink)]',
            )}
          >
            <span>{toast.tone === 'error' ? '⚠️' : '✓'}</span>
            <span>{toast.message}</span>
            <button
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
              aria-label="Dismiss"
              className="ml-1 text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): PushToast {
  return useContext(ToastContext);
}
