import { useMemo } from 'react';
import { cx } from '../../lib/util';
import { EmptyState } from '../ui';

interface Heading {
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

export default function TableOfContents({ blocks }: { blocks: unknown[] }) {
  const headings = useMemo(() => extractHeadings(blocks), [blocks]);

  if (headings.length === 0) {
    return <EmptyState icon="list-nested" title="No headings yet" hint="Headings you add appear here as an outline." />;
  }

  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <nav className="space-y-0.5 p-3">
      {headings.map((heading) => (
        <button
          key={heading.id}
          onClick={() => {
            // BlockNote renders each block with its id as the DOM data attribute.
            const el = document.querySelector(`[data-id="${heading.id}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
          className={cx(
            'block w-full truncate rounded px-2 py-1 text-left text-sm text-[var(--color-muted)]',
            'hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]',
            heading.level === minLevel && 'font-medium text-[var(--color-ink)]',
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
