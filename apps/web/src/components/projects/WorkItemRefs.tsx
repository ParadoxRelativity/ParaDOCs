import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workItemPath, type ProjectSummary, type WorkItemListing } from '@paradocs/shared';
import { useProjects, useWorkItemListing } from '../../api/hooks';
import { cx, useDebounced } from '../../lib/util';
import { useWorkItemRef } from '../../lib/workItemRefs';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { Button } from '../ui';
import { CATEGORY_ICON, StatusPill } from './projectUi';

/**
 * Work items outside Projects: the chip a document draws in a sentence, the
 * card a canvas places on the board, and the picker both insert them with —
 * and the picker a document links a whole board or queue with.
 * Each shows the item as it is now, looked up when drawn.
 */

/** The item's path, from the workspace in the address bar: references never leave their workspace. */
function useOpenItem() {
  const navigate = useNavigate();
  return (projectId: string, itemId: string) => {
    const workspaceId = /^\/w\/([^/]+)/.exec(window.location.pathname)?.[1];
    if (workspaceId) navigate(workItemPath(workspaceId, projectId, itemId));
  };
}

/** A work item in a document's text. */
export function WorkItemInlineChip({ itemId, label }: { itemId: string; label: string }) {
  const ref = useWorkItemRef(itemId);
  const open = useOpenItem();
  const item = ref.data;

  if (!item) {
    return (
      <span
        title={ref.isLoading ? 'Loading…' : 'This work item cannot be shown — it may be gone or not shared with you'}
        className="rounded bg-[var(--color-surface)] px-1 text-[var(--color-muted)]"
      >
        {label || 'Work item'}
      </span>
    );
  }
  const done = item.statusCategory === 'done';
  return (
    <span
      role="link"
      tabIndex={0}
      title={`${item.key} · ${item.statusName}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => open(item.projectId, item.id)}
      onKeyDown={(e) => e.key === 'Enter' && open(item.projectId, item.id)}
      className="cursor-pointer rounded bg-[var(--color-accent-soft)] px-1 text-[var(--color-accent)] hover:underline"
    >
      <Icon name={CATEGORY_ICON[item.statusCategory]} className="mr-1 text-[10px]" />
      <span className={cx('font-medium', done && 'line-through opacity-70')}>{item.key}</span> {item.title}
    </span>
  );
}

/** A work item as a card on a canvas. Double-clicking it, as with a document card, makes it interactive. */
export function WorkItemCard({ itemId, label, interactive }: { itemId: string; label?: string; interactive: boolean }) {
  const ref = useWorkItemRef(itemId);
  const open = useOpenItem();
  const item = ref.data;

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <Icon name="kanban" />
        <span className="font-medium">{item?.key ?? 'Work item'}</span>
        <span className="flex-1" />
        {item && interactive && (
          <Button variant="subtle" className="px-2 py-0.5 text-xs" onClick={() => open(item.projectId, item.id)}>
            Open
          </Button>
        )}
      </div>
      {item ? (
        <>
          <p className={cx('line-clamp-2 text-sm font-medium leading-snug', item.statusCategory === 'done' && 'text-[var(--color-muted)] line-through')}>
            {item.title}
          </p>
          <div className="mt-auto">
            <StatusPill status={{ name: item.statusName, color: item.statusColor, category: item.statusCategory }} />
          </div>
        </>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">
          {ref.isLoading ? 'Loading…' : `${label ?? 'This work item'} is not available — it may be gone or not shared with you.`}
        </p>
      )}
    </div>
  );
}

/** Chooses a work item from anywhere in the workspace, by title or key. */
export function WorkItemPicker({
  workspaceId,
  confirmLabel,
  onPick,
  onCancel,
}: {
  workspaceId: string;
  confirmLabel: string;
  onPick: (item: WorkItemListing) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 150);
  const results = useWorkItemListing(workspaceId, { q: debounced.trim() || undefined, limit: 20 });
  const [cursor, setCursor] = useState(0);
  const items = results.data ?? [];
  useEffect(() => setCursor(0), [debounced]);
  const chosen = items[cursor];

  return (
    <Modal
      title="Link a work item"
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
        placeholder="Search by title, or a key such as ENG-12"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              onMouseEnter={() => setCursor(index)}
              onClick={() => setCursor(index)}
              onDoubleClick={() => onPick(item)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === cursor ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
              )}
            >
              <span className="w-20 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 truncate text-xs text-[var(--color-muted)]">{item.project.name}</span>
              <StatusPill status={item.status} />
            </button>
          </li>
        ))}
        {!results.isLoading && items.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-[var(--color-muted)]">No work items match.</li>
        )}
      </ul>
    </Modal>
  );
}

/** Chooses a project's board or a queue, by name or key. */
export function ProjectPicker({
  workspaceId,
  confirmLabel,
  onPick,
  onCancel,
}: {
  workspaceId: string;
  confirmLabel: string;
  onPick: (project: ProjectSummary) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const projects = useProjects(workspaceId);
  const [cursor, setCursor] = useState(0);
  const needle = query.trim().toLowerCase();
  const items = (projects.data ?? []).filter(
    (p) => p.name.toLowerCase().includes(needle) || p.key.toLowerCase().includes(needle),
  );
  useEffect(() => setCursor(0), [needle]);
  const chosen = items[cursor];

  return (
    <Modal
      title="Link a board or queue"
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
        placeholder="Search by name, or a key such as ENG"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {items.map((project, index) => (
          <li key={project.id}>
            <button
              onMouseEnter={() => setCursor(index)}
              onClick={() => setCursor(index)}
              onDoubleClick={() => onPick(project)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === cursor ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
              )}
            >
              <Icon name={project.kind === 'queue' ? 'inboxes' : 'kanban'} className="text-[var(--color-muted)]" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-xs text-[var(--color-muted)]">{project.key}</span>
              <span className="w-12 shrink-0 text-right text-xs text-[var(--color-muted)]">
                {project.kind === 'queue' ? 'Queue' : 'Board'}
              </span>
            </button>
          </li>
        ))}
        {!projects.isLoading && items.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-[var(--color-muted)]">No boards or queues match.</li>
        )}
      </ul>
    </Modal>
  );
}
