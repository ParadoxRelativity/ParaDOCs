import { useMemo, useState } from 'react';
import { cx } from '../lib/util';
import { extractHeadings, useActiveHeading } from './panels/TableOfContents';

/**
 * The contents, for when the sidebar that holds them is closed: a mark per
 * heading down the right edge of the page, the one you are under lit. Pointing
 * at it opens the headings out beside the marks, and either can be clicked to
 * jump there.
 */
export default function DocumentOutline({ blocks }: { blocks: unknown[] }) {
  const headings = useMemo(() => extractHeadings(blocks), [blocks]);
  const { active, jumpTo } = useActiveHeading(headings);
  const [open, setOpen] = useState(false);

  // One heading is no map; it would only say the page has a top.
  if (headings.length < 2) return null;

  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <nav
      aria-label="Contents"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      className={cx(
        'scroll-thin absolute top-1/2 right-3 z-10 max-h-[70%] -translate-y-1/2 overflow-y-auto rounded-lg py-2 transition-colors',
        open
          ? 'w-60 border border-[var(--color-line)] bg-[var(--color-raised)] shadow-lg'
          : 'w-8 border border-transparent',
      )}
    >
      {headings.map((heading) => {
        const depth = Math.min(heading.level - minLevel, 2);
        const current = heading.id === active;
        return (
          <button
            key={heading.id}
            onClick={() => jumpTo(heading.id)}
            aria-current={current ? 'location' : undefined}
            aria-label={heading.text}
            title={open ? heading.text : undefined}
            className={cx(
              'flex w-full items-center gap-2 py-[3px] pr-2 text-left text-xs',
              open && 'hover:bg-[var(--color-surface)]',
            )}
          >
            <span
              className={cx(
                'min-w-0 flex-1 truncate',
                !open && 'sr-only',
                current ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
              )}
              style={{ paddingLeft: 12 + depth * 10 }}
            >
              {heading.text}
            </span>
            <span
              aria-hidden
              className={cx(
                'ml-auto h-0.5 shrink-0 rounded-full transition-colors',
                current ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-muted)]/50',
              )}
              style={{ width: 16 - depth * 4 }}
            />
          </button>
        );
      })}
    </nav>
  );
}
