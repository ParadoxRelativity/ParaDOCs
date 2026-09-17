import { useMemo, useState } from 'react';
import type { Project, ProjectStatus, WorkItemSummary, WorkspaceMember } from '@paradocs/shared';
import { useCreateWorkItem, useMoveWorkItems, useUpdateWorkItem } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { positionBetween } from './ProjectBoard';
import { PeopleStack, PriorityIcon, StatusPill, TypeIcon, formatDue } from './projectUi';

const DRAG_TYPE = 'application/x-paradocs-backlog-item';

/** How many rows are drawn before asking to see more; a backlog can run to hundreds. */
const PAGE = 100;

/**
 * Work nobody has queued to start, in the order it should be taken on. The
 * top of the list is what goes on the board next: drag to rank it, tick what
 * is ready, and move it onto the board together.
 */
export default function ProjectBacklog({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  onOpenBoard,
}: {
  project: Project;
  /** Every item in the project; the backlog picks out its own. */
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onOpenBoard: () => void;
}) {
  const backlogStatuses = project.statuses.filter((s) => s.category === 'backlog');
  const boardStatuses = project.statuses.filter((s) => s.category !== 'backlog');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState(boardStatuses.find((s) => s.category === 'todo')?.id ?? boardStatuses[0]?.id ?? '');
  const [shown, setShown] = useState(PAGE);
  const move = useMoveWorkItems(project.id);
  const toast = useToast();

  const groups = useMemo(
    () =>
      backlogStatuses.map((status) => ({
        status,
        items: items
          .filter((item) => item.statusId === status.id)
          .sort((a, b) => a.position - b.position || a.number - b.number),
      })),
    // The statuses' identity changes with every refetch; their ids and order are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, backlogStatuses.map((s) => s.id).join()],
  );
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const estimate = groups.reduce((sum, group) => sum + group.items.reduce((t, i) => t + (i.estimate ?? 0), 0), 0);
  const onBoard = items.length - total;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveToBoard(ids: string[]) {
    if (!target || ids.length === 0) return;
    const statusName = boardStatuses.find((s) => s.id === target)?.name ?? 'the board';
    // In backlog order, so what was ranked first lands first.
    const order = groups.flatMap((group) => group.items.map((item) => item.id)).filter((id) => ids.includes(id));
    move.mutate(
      { itemIds: order, statusId: target },
      {
        onSuccess: () => {
          setSelected(new Set());
          toast(order.length === 1 ? `Moved to ${statusName}` : `Moved ${order.length} items to ${statusName}`);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not move them', 'error'),
      },
    );
  }

  if (backlogStatuses.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-[var(--color-muted)]">
        This {project.kind} has no backlog status. Add one in its settings, marked as Backlog, to keep unplanned work off the board.
      </p>
    );
  }

  let budget = shown;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2 text-sm">
        <span className="font-medium">{total === 1 ? '1 item' : `${total} items`}</span>
        {estimate > 0 && <span className="text-xs text-[var(--color-muted)]">· {Number(estimate.toFixed(2))} estimated</span>}
        <button onClick={onOpenBoard} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
          · {onBoard} on the board
        </button>
        <span className="flex-1" />
        {canEdit && selected.size > 0 && (
          <>
            <span className="text-xs text-[var(--color-muted)]">{selected.size} selected</span>
            <Button variant="subtle" className="text-xs" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        )}
        {canEdit && boardStatuses.length > 0 && (
          <>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              aria-label="Board status to move to"
            >
              {boardStatuses.map((s) => (
                <option key={s.id} value={s.id}>
                  To {s.name}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              className="text-xs"
              disabled={selected.size === 0 || move.isPending}
              onClick={() => moveToBoard([...selected])}
            >
              <Icon name="kanban" /> Move to board
            </Button>
          </>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-6">
        {groups.map(({ status, items: rows }) => {
          const visible = rows.slice(0, Math.max(0, budget));
          budget -= visible.length;
          return (
            <BacklogGroup
              key={status.id}
              project={project}
              status={status}
              heading={backlogStatuses.length > 1}
              items={rows}
              visible={visible}
              memberMap={memberMap}
              canEdit={canEdit}
              activeItemId={activeItemId}
              selected={selected}
              onToggle={toggle}
              onToggleAll={(on) =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const item of rows) {
                    if (on) next.add(item.id);
                    else next.delete(item.id);
                  }
                  return next;
                })
              }
              onOpenItem={onOpenItem}
              onMoveOne={boardStatuses.length > 0 ? (id) => moveToBoard([id]) : undefined}
            />
          );
        })}
        {total > shown && (
          <div className="px-4 pt-3">
            <Button variant="subtle" className="text-xs" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, total - shown)} more of {total - shown}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BacklogGroup({
  project,
  status,
  heading,
  items,
  visible,
  memberMap,
  canEdit,
  activeItemId,
  selected,
  onToggle,
  onToggleAll,
  onOpenItem,
  onMoveOne,
}: {
  project: Project;
  status: ProjectStatus;
  heading: boolean;
  items: WorkItemSummary[];
  visible: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  onOpenItem: (id: string) => void;
  onMoveOne?: (id: string) => void;
}) {
  const create = useCreateWorkItem(project.id);
  const update = useUpdateWorkItem(project.id);
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [drop, setDrop] = useState<number | null>(null);
  const primaryRole = project.roles[0];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  function add() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTitle('');
    create.mutate(
      { title: trimmed, statusId: status.id },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not add it', 'error') },
    );
  }

  /** `index` counts the list as drawn, with the dragged row still in it. */
  function rank(itemId: string, index: number) {
    const dragged = items.find((item) => item.id === itemId);
    const original = items.findIndex((item) => item.id === itemId);
    if (original !== -1 && (original === index || original === index - 1)) return;
    const rest = items.filter((item) => item.id !== itemId);
    const at = original !== -1 && index > original ? index - 1 : index;
    update.mutate(
      {
        id: itemId,
        statusId: dragged ? undefined : status.id,
        position: positionBetween(rest[at - 1]?.position, rest[at]?.position),
      },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move it', 'error') },
    );
  }

  return (
    <section
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        if ((e.target as HTMLElement).closest('[data-row]') === null) setDrop(visible.length);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        const index = drop;
        setDrop(null);
        if (id && index !== null) {
          e.preventDefault();
          rank(id, index);
        }
      }}
    >
      {heading && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-4 py-1.5">
          <StatusPill status={status} />
          <span className="text-xs text-[var(--color-muted)]">{items.length}</span>
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-1.5">
        {canEdit && items.length > 0 ? (
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => onToggleAll(e.target.checked)}
            aria-label={`Select everything in ${status.name}`}
          />
        ) : (
          <span className="w-[13px]" />
        )}
        {canEdit && !project.archivedAt ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={`Add to ${status.name.toLowerCase()} — press Enter`}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-[var(--color-muted)]"
          />
        ) : (
          <span className="flex-1" />
        )}
      </div>

      <ol>
        {visible.map((item, index) => (
          <li key={item.id} data-row>
            {drop === index && <div className="h-0.5 bg-[var(--color-accent)]" />}
            <div
              draggable={canEdit}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, item.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDrop(null)}
              onDragOver={(e) => {
                if (!canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDrop(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
              }}
              onClick={() => onOpenItem(item.id)}
              className={cx(
                'group flex cursor-pointer items-center gap-2 border-b border-[var(--color-line)] px-4 py-1.5 text-sm',
                item.id === activeItemId
                  ? 'bg-[var(--color-accent-soft)]'
                  : selected.has(item.id)
                    ? 'bg-[var(--color-surface)]'
                    : 'hover:bg-[var(--color-surface)]',
              )}
            >
              {canEdit ? (
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggle(item.id)}
                  aria-label={`Select ${item.key}`}
                />
              ) : (
                <span className="w-[13px]" />
              )}
              {canEdit && <Icon name="grip-vertical" className="cursor-grab text-xs text-[var(--color-muted)] opacity-0 group-hover:opacity-100" />}
              <TypeIcon type={item.type} />
              <span className="w-16 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.priority !== 'none' && <PriorityIcon priority={item.priority} />}
              {item.dueDate && <span className="text-xs text-[var(--color-muted)]">{formatDue(item.dueDate)}</span>}
              {item.estimate !== null && (
                <span className="rounded bg-[var(--color-surface)] px-1 text-xs tabular-nums text-[var(--color-muted)]">
                  {item.estimate}
                </span>
              )}
              <PeopleStack userIds={primaryRole ? (item.roles[primaryRole.id] ?? []) : []} members={memberMap} size="xs" />
              {canEdit && onMoveOne && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveOne(item.id);
                  }}
                  title="Move to the board"
                  className="hidden shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] group-hover:inline"
                >
                  To board
                </button>
              )}
            </div>
          </li>
        ))}
        {drop === visible.length && <li className="h-0.5 bg-[var(--color-accent)]" />}
      </ol>
      {items.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-muted)]">Nothing waiting. New ideas and requests collect here until they are planned.</p>
      )}
    </section>
  );
}
