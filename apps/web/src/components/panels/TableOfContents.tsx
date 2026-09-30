import { useEffect, useMemo, useState } from 'react';
import { cx } from '../../lib/util';
import { EmptyState } from '../ui';

export interface Heading {
  id: string;
  level: number;
  text: string;
}

/** Reads headings straight from the BlockNote block array, so it tracks edits live. */
export function extractHeadings(blocks: unknown[]): Heading[] {
  const out: Heading[] = [];
  const walk = (list: unknown[]) => {
    for (const raw of list) {
      const block = raw as {
        id?: string;
        type?: string;
        props?: { level?: number };
        content?: { text?: string }[];
        children?: unknown[];
      };
      if (block.type === 'heading' && block.id) {
        const text = (block.content ?? []).map((c) => c.text ?? '').join('').trim();
        if (text) out.push({ id: block.id, level: Number(block.props?.level ?? 1), text });
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/** BlockNote renders each block with its id as the DOM data attribute. */
function headingElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.bn-editor [data-id="${CSS.escape(id)}"]`);
}

function scrollParent(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.documentElement;
}

/**
 * Which heading the reader is under: the last one that has reached the middle
 * of the scrolled view, since jumping to a heading centres it. A heading that
 * was jumped to stays current until the reader scrolls for themselves, as one
 * near the end of the page may never get as far as the middle.
 */
export function useActiveHeading(headings: Heading[]) {
  const [measured, setMeasured] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      let current: string | null = null;
      let line: number | null = null;
      for (const heading of headings) {
        const el = headingElement(heading.id);
        if (!el) continue;
        if (line === null) {
          const scroller = scrollParent(el);
          const top = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
          line = top + scroller.clientHeight / 2 + 1;
        }
        if (el.getBoundingClientRect().top > line) break;
        current = heading.id;
      }
      setMeasured(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const release = () => setChosen(null);

    schedule();
    // Capturing, so the editor's own scrolling box is heard without a ref to it.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
      window.addEventListener(type, release, { passive: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
        window.removeEventListener(type, release);
      }
    };
  }, [headings]);

  const active = chosen && headings.some((h) => h.id === chosen) ? chosen : measured;

  function jumpTo(id: string) {
    headingElement(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setChosen(id);
  }

  return { active, jumpTo };
}

export default function TableOfContents({ blocks }: { blocks: unknown[] }) {
  const headings = useMemo(() => extractHeadings(blocks), [blocks]);
  const { active, jumpTo } = useActiveHeading(headings);

  if (headings.length === 0) {
    return <EmptyState icon="list-nested" title="No headings yet" />;
  }

  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <nav className="space-y-0.5 p-3">
      {headings.map((heading) => (
        <button
          key={heading.id}
          onClick={() => jumpTo(heading.id)}
          aria-current={heading.id === active ? 'location' : undefined}
          className={cx(
            'block w-full truncate rounded px-2 py-1 text-left text-sm',
            heading.level === minLevel && 'font-medium',
            heading.id === active
              ? 'bg-[var(--color-canvas)] text-[var(--color-accent)]'
              : cx(
                  heading.level === minLevel ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]',
                  'hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]',
                ),
          )}
          style={{ paddingLeft: 8 + (heading.level - minLevel) * 12 }}
          title={heading.text}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  );
}
