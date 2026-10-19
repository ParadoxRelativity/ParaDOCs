import { useEffect, useState } from 'react';
import { useLinkTargets } from '../../api/hooks';
import { cx, useDebounced } from '../../lib/util';
import { PresentationIcon } from '../Icon';
import { Modal } from '../Modal';
import { Button } from '../ui';

/** Choosing a presentation to link, from those the reader can open, searched by title as it is typed. */
export function PresentationPicker({
  workspaceId,
  confirmLabel,
  onPick,
  onCancel,
}: {
  workspaceId: string;
  confirmLabel: string;
  onPick: (presentation: { id: string; title: string }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 150);
  const targets = useLinkTargets(workspaceId, debounced, { kinds: ['presentations'], limit: 20 });
  const [cursor, setCursor] = useState(0);
  const items = targets.data?.presentations ?? [];
  useEffect(() => setCursor(0), [debounced]);
  const chosen = items[cursor];

  return (
    <Modal
      title="Link a presentation"
      onClose={onCancel}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && chosen) {
            e.preventDefault();
            onPick(chosen);
          }
        }}
        placeholder="Search by title"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {items.map((presentation, index) => (
          <li key={presentation.id}>
            <button
              onMouseEnter={() => setCursor(index)}
              onClick={() => setCursor(index)}
              onDoubleClick={() => onPick(presentation)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === cursor ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
              )}
            >
              <PresentationIcon presentation={presentation} className="text-xs" />
              <span className="min-w-0 flex-1 truncate">{presentation.title || 'Untitled'}</span>
            </button>
          </li>
        ))}
        {targets.isSuccess && items.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No presentations match.</li>}
      </ul>
    </Modal>
  );
}
