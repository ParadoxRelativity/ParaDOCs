import { useState } from 'react';
import { canMoveTo, type Project, type ProjectStatus, type WorkItemSummary, type WorkspaceMember } from '@paradocs/shared';
import { useUpdateWorkItem } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { PeopleStack, PriorityIcon, StatusPill, TypeIcon, formatDue, isOverdue } from './projectUi';

/** What a dragged card carries, so nothing else can be dropped on a column. */
const DRAG_TYPE = 'application/x-paradocs-work-item';

/** A position between two neighbours, or past whichever end there is. */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/**
 * A project laid out as columns, one per status in the project's order. Cards
 * are dragged between and within columns; where one is dropped is where it
 * stays, for everyone. Backlog statuses have no column: what is in them is not
 * planned yet, and has a view of its own.
 *
 * Where a card may be dropped is what the workflow its type follows allows.
 * Columns it does not are dimmed while the card is in the air and will not take
 * it, so a move that the server would refuse cannot be started.
 */
export default function ProjectBoard({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  onOpenBacklog,
}: {
  project: Project;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onOpenBacklog?: () => void;
}) {
  const update = useUpdateWorkItem(project.id);
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ statusId: string; index: number } | null>(null);

  const columns = project.statuses.filter((s) => s.category !== 'backlog');
  const held = dragging ? items.find((item) => item.id === dragging) : undefined;
  /** Whether the card in the air may be dropped here. Nothing in the air: anywhere. */
  const takes = (statusId: string) => !held || canMoveTo(project, held.type, held.statusId, statusId);
  const backlogIds = new Set(project.statuses.filter((s) => s.category === 'backlog').map((s) => s.id));
  const backlogCount = items.filter((item) => backlogIds.has(item.statusId)).length;
  const byStatus = new Map<string, WorkItemSummary[]>(columns.map((s) => [s.id, []]));
  for (const item of items) byStatus.get(item.statusId)?.push(item);
  for (const column of byStatus.values()) column.sort((a, b) => a.position - b.position || a.number - b.number);

  /** `index` counts the column as drawn, with the dragged card still in it. */
  function moveTo(statusId: string, index: number, itemId: string) {
    const current = items.find((item) => item.id === itemId);
    if (!current) return;
    const original = (byStatus.get(statusId) ?? []).findIndex((item) => item.id === itemId);
    // Dropped back where it already was.
    if (original !== -1 && (original === index || original === index - 1)) return;
    const column = (byStatus.get(statusId) ?? []).filter((item) => item.id !== itemId);
    const target = original !== -1 && index > original ? index - 1 : index;
    const position = positionBetween(column[target - 1]?.position, column[target]?.position);
    update.mutate(
      { id: itemId, statusId: statusId === current.statusId ? undefined : statusId, position },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the work item', 'error') },
    );
  }

  return (
    <div className="scroll-thin flex h-full gap-3 overflow-x-auto p-4">
      {backlogIds.size > 0 && onOpenBacklog && (
        <button
          onClick={onOpenBacklog}
          title="Work not yet planned"
          className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-[var(--color-surface)] py-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          <Icon name="inbox" />
          <span className="font-medium tabular-nums">{backlogCount}</span>
          <span className="[writing-mode:vertical-rl]">Backlog</span>
        </button>
      )}
      {columns.map((status) => {
        const column = byStatus.get(status.id) ?? [];
        return (
          <Column
            key={status.id}
            project={project}
            status={status}
            items={column}
            memberMap={memberMap}
            canEdit={canEdit}
            activeItemId={activeItemId}
            dragging={dragging}
            takesDrop={takes(status.id)}
            dropIndex={drop?.statusId === status.id ? drop.index : null}
            onOpenItem={onOpenItem}
            onDragStart={setDragging}
            onDragEnd={() => {
              setDragging(null);
              setDrop(null);
            }}
            onDragOverIndex={(index) => setDrop({ statusId: status.id, index })}
            onDropAt={(index, itemId) => {
              setDrop(null);
              setDragging(null);
              moveTo(status.id, index, itemId);
            }}
          />
        );
      })}
    </div>
  );
}

function Column({
  project,
  status,
  items,
  memberMap,
  canEdit,
  activeItemId,
  dragging,
  takesDrop,
  dropIndex,
  onOpenItem,
  onDragStart,
  onDragEnd,
  onDragOverIndex,
  onDropAt,
}: {
  project: Project;
  status: ProjectStatus;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  dragging: string | null;
  /** False while a card whose workflow forbids this status is being dragged. */
  takesDrop: boolean;
  dropIndex: number | null;
  onOpenItem: (itemId: string) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDragOverIndex: (index: number) => void;
  onDropAt: (index: number, itemId: string) => void;
}) {
  const estimate = items.reduce((total, item) => total + (item.estimate ?? 0), 0);
  const primaryRole = project.roles[0];

  const indicator = <div className="h-0.5 rounded-full bg-[var(--color-accent)]" />;

  return (
    <section
      className={cx(
        'flex w-72 shrink-0 flex-col rounded-xl bg-[var(--color-surface)] transition-opacity',
        dragging && !takesDrop && 'opacity-40',
      )}
      title={dragging && !takesDrop ? `${status.name} is not a move this item's workflow allows` : undefined}
      onDragOver={(e) => {
        // Not preventing the default is what refuses the drop.
        if (!canEdit || !takesDrop || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        // Over the column but past its cards: the end of it.
        if ((e.target as HTMLElement).closest('[data-card]') === null) onDragOverIndex(items.length);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || dropIndex === null || !takesDrop) return;
        e.preventDefault();
        onDropAt(dropIndex, id);
      }}
    >
      <header className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <StatusPill status={status} />
        <span className="text-xs text-[var(--color-muted)]">{items.length}</span>
        {estimate > 0 && (
          <span className="text-xs text-[var(--color-muted)]" title="Total estimate">
            · {Number(estimate.toFixed(2))} est
          </span>
        )}
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2 pt-1">
        {items.map((item, index) => {
          const holders = primaryRole ? (item.roles[primaryRole.id] ?? []) : [];
          const holderNames = primaryRole?.freeForm ? (item.roleNames[primaryRole.id] ?? []) : [];
          const overdue = isOverdue(item.dueDate, status.category === 'done');
          return (
            <div key={item.id}>
              {dropIndex === index && dragging !== item.id && indicator}
              <button
                data-card
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, item.id);
                  e.dataTransfer.effectAllowed = 'move';
                  onDragStart(item.id);
                }}
                onDragEnd={onDragEnd}
                onDragOver={(e) => {
                  if (!canEdit || !takesDrop || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  onDragOverIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
                }}
                onClick={() => onOpenItem(item.id)}
                className={cx(
                  'mt-1.5 block w-full rounded-lg border bg-[var(--color-raised)] p-2.5 text-left shadow-sm transition-colors',
                  item.id === activeItemId
                    ? 'border-[var(--color-accent)]'
                    : 'border-transparent hover:border-[var(--color-line)]',
                  dragging === item.id && 'opacity-40',
                )}
              >
                <p className={cx('text-sm leading-snug', status.category === 'done' && 'text-[var(--color-muted)] line-through')}>
                  {item.title}
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                  <TypeIcon type={item.type} />
                  <span>{item.key}</span>
                  {item.priority !== 'none' && <PriorityIcon priority={item.priority} />}
                  {item.dueDate && (
                    <span className={cx('flex items-center gap-0.5', overdue && 'text-red-500')}>
                      <Icon name="calendar-event" className="text-[10px]" />
                      {formatDue(item.dueDate)}
                    </span>
                  )}
                  {item.commentCount > 0 && (
                    <span className="flex items-center gap-0.5">
                      <Icon name="chat-left-text" className="text-[10px]" />
                      {item.commentCount}
                    </span>
                  )}
                  <span className="flex-1" />
                  {item.estimate !== null && (
                    <span className="rounded bg-[var(--color-surface)] px-1 tabular-nums" title="Estimate">
                      {item.estimate}
                    </span>
                  )}
                  <PeopleStack userIds={holders} names={holderNames} members={memberMap} max={2} size="xs" />
                </div>
              </button>
            </div>
          );
        })}
        {dropIndex === items.length && indicator}
        {items.length === 0 && <p className="px-2 py-4 text-center text-xs text-[var(--color-muted)]">Nothing here</p>}
      </div>
    </section>
  );
}
