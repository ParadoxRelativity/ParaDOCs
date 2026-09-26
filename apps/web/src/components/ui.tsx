import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';

/**
 * A styled tooltip for icon-only controls.
 *
 * The native `title` attribute waits about a second and is drawn by the OS, so
 * a toolbar of unlabelled icons is hard to learn from. This appears promptly,
 * matches the app, and also shows on keyboard focus.
 *
 * It renders into a portal so a toolbar that wraps or scrolls cannot clip it.
 */
export function Tooltip({
  label,
  children,
  delayMs = 250,
}: {
  label: string;
  children: ReactNode;
  delayMs?: number;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  function show() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: rect.left + rect.width / 2, top: rect.bottom + 8 });
    }, delayMs);
  }

  // Keep the bubble on screen. This runs after it renders because the clamp
  // needs its real width; guessing one squashed long labels near an edge into
  // a narrow column.
  useLayoutEffect(() => {
    if (!position || !bubble.current) return;
    const margin = 8;
    const half = bubble.current.offsetWidth / 2;
    const clamped = Math.min(
      Math.max(position.left, margin + half),
      window.innerWidth - margin - half,
    );
    if (Math.abs(clamped - position.left) > 0.5) {
      setPosition((current) => (current ? { ...current, left: clamped } : current));
    }
  }, [position]);

  function hide() {
    clearTimeout(timer.current);
    setPosition(null);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onPointerEnter={show}
      onPointerLeave={hide}
      // Dismiss on press, so clicking a tool does not leave a tooltip behind.
      onPointerDown={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {position &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            className={cx(
              'pointer-events-none fixed z-[80] w-max max-w-64 -translate-x-1/2 rounded-md px-2 py-1',
              'border border-[var(--color-line)] bg-[var(--color-raised)] text-xs',
              'text-[var(--color-ink)] shadow-lg',
            )}
            style={{ left: position.left, top: position.top }}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * A single-field editor rendered in place of the thing being named. Enter or
 * blur commits a non-empty value, Escape cancels. Used instead of window.prompt
 * so naming happens where the item will appear.
 */
export function InlineInput({
  defaultValue = '',
  placeholder,
  onCommit,
  onCancel,
  className,
  style,
}: {
  defaultValue?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [value, setValue] = useState(defaultValue);
  // Removing a focused input can fire blur on the way out; without this guard
  // committing with Enter would submit twice.
  const settled = useRef(false);

  function settle(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    const trimmed = value.trim();
    if (commit && trimmed) onCommit(trimmed);
    else onCancel();
  }

  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          settle(true);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          settle(false);
        }
      }}
      onBlur={() => settle(true)}
      onClick={(e) => e.stopPropagation()}
      style={style}
      className={cx(
        'w-full rounded border border-[var(--color-accent)] bg-[var(--color-canvas)] px-1.5 py-1',
        'text-sm outline-none',
        className,
      )}
    />
  );
}

/**
 * Inline editor for an optional icon plus a name, used for folders. Enter or
 * blurring away from the whole form commits; Escape cancels. Kept inline rather
 * than a dialog so naming still happens where the folder appears.
 */
export function InlineIconNameForm({
  defaultIcon = '',
  defaultName = '',
  namePlaceholder,
  onCommit,
  onCancel,
}: {
  defaultIcon?: string;
  defaultName?: string;
  namePlaceholder?: string;
  onCommit: (name: string, icon: string | null) => void;
  onCancel: () => void;
}) {
  const [icon, setIcon] = useState(defaultIcon);
  const [name, setName] = useState(defaultName);
  const settled = useRef(false);
  const container = useRef<HTMLDivElement>(null);

  function settle(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    const trimmed = name.trim();
    if (commit && trimmed) onCommit(trimmed, icon.trim() || null);
    else onCancel();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      settle(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      settle(false);
    }
  }

  const field =
    'rounded border border-[var(--color-accent)] bg-[var(--color-canvas)] px-1.5 py-1 text-sm outline-none';

  return (
    <div
      ref={container}
      className="flex min-w-0 flex-1 items-center gap-1"
      // Moving between the two fields must not commit, so only a blur that
      // leaves the form entirely counts.
      onBlur={(e) => {
        if (!container.current?.contains(e.relatedTarget as Node | null)) settle(true);
      }}
    >
      <input
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={2}
        placeholder="—"
        aria-label="Folder icon (optional)"
        title="Icon (optional)"
        className={cx(field, 'w-8 shrink-0 text-center')}
      />
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={namePlaceholder}
        aria-label="Folder name"
        className={cx(field, 'min-w-0 flex-1')}
      />
    </div>
  );
}

export function Button({
  variant = 'ghost',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'subtle' | 'danger' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors ' +
    'disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-[var(--color-accent)]';
  const variants = {
    primary: 'bg-[var(--color-accent)] text-white hover:opacity-90 px-3 py-1.5',
    ghost: 'hover:bg-[var(--color-surface)] text-[var(--color-ink)] px-2 py-1',
    subtle: 'bg-[var(--color-surface)] hover:bg-[var(--color-line)] px-3 py-1.5',
    danger: 'text-red-500 hover:bg-red-500/10 px-2 py-1',
  };
  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      title={label}
      aria-label={label}
      className={cx(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-muted)]',
        'hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] transition-colors',
        className,
      )}
      {...props}
    />
  );
}

export function TagChip({
  name,
  color,
  onRemove,
  onClick,
  active,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <span
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        onClick && 'cursor-pointer',
        active && 'ring-1',
      )}
      style={{
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
        // @ts-expect-error CSS custom property on ring color
        '--tw-ring-color': color,
      }}
    >
      {name}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove tag ${name}`}
          className="opacity-60 hover:opacity-100"
        >
          <Icon name="x-lg" />
        </button>
      )}
    </span>
  );
}

export function EmptyState({ icon, title, hint }: { icon: IconName; title: string; hint?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-3xl opacity-40">
        <Icon name={icon} />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-xs text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" />
    </div>
  );
}

/**
 * The end of a list read a page at a time: asks for the next page as it comes
 * into view, a screenful early so scrolling rarely waits, with a button for
 * doing it by hand, and a retry when a page failed.
 */
export function LoadMore({
  hasMore,
  loading,
  failed,
  onLoadMore,
  label = 'Load more',
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasMore || loading || failed) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), {
      rootMargin: '0px 0px 600px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, failed, onLoadMore]);

  if (!hasMore && !loading && !failed) return null;
  return (
    <div ref={ref} className="py-3 text-center text-xs text-[var(--color-muted)]">
      {loading ? (
        'Loading…'
      ) : failed ? (
        <button onClick={onLoadMore} className="hover:text-[var(--color-ink)]">
          Could not load more. Try again
        </button>
      ) : (
        <button onClick={onLoadMore} className="hover:text-[var(--color-ink)]">
          {label}
        </button>
      )}
    </div>
  );
}
