import type { DocumentMode } from '@paradocs/shared';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';

const MODES: { mode: DocumentMode; label: string; icon: IconName }[] = [
  { mode: 'page', label: 'Page', icon: 'file-earmark-text' },
  { mode: 'canvas', label: 'Canvas', icon: 'easel' },
];

/**
 * Switches the open document between writing and drawing.
 *
 * The two halves of a document are a thing you move between while working, not
 * a setting you configure, so this sits in the header where the document is
 * rather than behind a panel. The thumb slides rather than blinking across:
 * the movement is what says the two modes are the same document seen two ways,
 * which matters because switching keeps both sides intact.
 *
 * It is a radio group rather than a switch — "on" and "off" would be the wrong
 * idea for two peers — so the arrow keys move between them.
 */
export default function ModeSwitch({
  mode,
  onChange,
  disabled = false,
}: {
  mode: DocumentMode;
  onChange: (mode: DocumentMode) => void;
  disabled?: boolean;
}) {
  const index = Math.max(0, MODES.findIndex((option) => option.mode === mode));
  /** Where the arrows go from here, wrapping so the row is a loop. */
  const step = (direction: number) => MODES[(index + direction + MODES.length) % MODES.length].mode;

  return (
    <div
      role="radiogroup"
      aria-label="Document mode"
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onChange(step(event.key === 'ArrowRight' ? 1 : -1));
      }}
      className={cx(
        'relative grid shrink-0 rounded-full border border-[var(--color-line)]',
        'bg-[var(--color-surface)] p-0.5 text-xs',
        disabled && 'opacity-50',
      )}
      style={{ gridTemplateColumns: `repeat(${MODES.length}, minmax(0, 1fr))` }}
    >
      {/* The travelling part. Sized to one segment and moved by whole segments,
          so it stays aligned whatever the labels measure. */}
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute bottom-0.5 top-0.5 rounded-full',
          'bg-[var(--color-raised)] shadow-sm ring-1 ring-[var(--color-line)]',
          'transition-[left] duration-200 ease-out motion-reduce:transition-none',
        )}
        style={{
          // One segment wide, moved by whole segments. The 0.125rem is the
          // track's own padding, which the first position has to clear and the
          // rest have already absorbed.
          width: `calc(${100 / MODES.length}% - 0.125rem)`,
          left: index === 0 ? '0.125rem' : `${(index * 100) / MODES.length}%`,
        }}
      />

      {MODES.map((option) => {
        const active = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            // Only the selected option is tabbed to; the arrows move from there.
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            title={active ? `Showing as ${option.label.toLowerCase()}` : `Switch to ${option.label.toLowerCase()}`}
            onClick={() => !active && onChange(option.mode)}
            className={cx(
              'relative z-10 flex items-center justify-center gap-1.5 rounded-full px-2.5 py-1',
              'transition-colors focus-visible:outline-2 focus-visible:outline-offset-1',
              'focus-visible:outline-[var(--color-accent)]',
              active ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-muted)]',
              !active && !disabled && 'hover:text-[var(--color-ink)]',
              disabled && 'cursor-default',
            )}
          >
            <Icon name={option.icon} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
