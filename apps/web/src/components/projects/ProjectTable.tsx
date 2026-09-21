import { useMemo, useState } from 'react';
import {
  WORK_ITEM_PRIORITIES,
  itemTypeOf,
  type Project,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useUpdateWorkItem } from '../../api/hooks';
import { cx, formatRelative } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { BlockedBadge, PeopleStack, PriorityIcon, TypeIcon, formatDue, isOverdue } from './projectUi';

type SortKey = 'key' | 'title' | 'status' | 'priority' | 'due' | 'estimate' | 'updated' | 'created';

/**
 * Work items as rows. A queue is worked through oldest first, so that is how
 * it starts; a project starts by status. Any column header re-sorts, and the
 * status can be changed without opening the item.
 */
export default function ProjectTable({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
}: {
  project: Project;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
}) {
  const update = useUpdateWorkItem(project.id);
  const toast = useToast();
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>(
    project.kind === 'queue' ? { key: 'created', descending: false } : { key: 'status', descending: false },
  );
  const [showDone, setShowDone] = useState(project.kind !== 'queue');
  // Unplanned work stays out of the way unless asked for.
  const [showBacklog, setShowBacklog] = useState(false);

  const statusIndex = useMemo(() => new Map(project.statuses.map((s, index) => [s.id, index])), [project.statuses]);
  const statusOf = (item: WorkItemSummary) => project.statuses[statusIndex.get(item.statusId) ?? 0];
  const primaryRole = project.roles[0];
  const doneCount = items.filter((item) => statusOf(item)?.category === 'done').length;
  const backlogCount = items.filter((item) => statusOf(item)?.category === 'backlog').length;

  const rows = useMemo(() => {
    const visible = items.filter((item) => {
      const category = statusOf(item)?.category;
      return (showDone || category !== 'done') && (showBacklog || category !== 'backlog');
    });
    const compare: Record<SortKey, (a: WorkItemSummary, b: WorkItemSummary) => number> = {
      key: (a, b) => a.number - b.number,
      title: (a, b) => a.title.localeCompare(b.title),
      status: (a, b) => (statusIndex.get(a.statusId) ?? 0) - (statusIndex.get(b.statusId) ?? 0) || a.position - b.position,
      priority: (a, b) => WORK_ITEM_PRIORITIES.indexOf(a.priority) - WORK_ITEM_PRIORITIES.indexOf(b.priority),
      // Undated work sorts after dated work, whichever way round.
      due: (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
      estimate: (a, b) => (a.estimate ?? -1) - (b.estimate ?? -1),
      updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      created: (a, b) => a.createdAt.localeCompare(b.createdAt),
    };
    const sorted = [...visible].sort((a, b) => compare[sort.key](a, b) || a.number - b.number);
    return sort.descending ? sorted.reverse() : sorted;
    // statusOf reads statusIndex, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort, showDone, showBacklog, statusIndex]);

  function header(key: SortKey, label: string, className?: string) {
    const active = sort.key === key;
    return (
      <th className={cx('px-2 py-1.5 font-medium', className)}>
        <button
          onClick={() => setSort({ key, descending: active ? !sort.descending : key === 'updated' })}
          className={cx('inline-flex items-center gap-1 hover:text-[var(--color-ink)]', active && 'text-[var(--color-ink)]')}
        >
          {label}
          {active && <Icon name={sort.descending ? 'chevron-down' : 'chevron-up'} className="text-[9px]" />}
        </button>
      </th>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-[var(--color-canvas)] text-left text-xs text-[var(--color-muted)] shadow-[inset_0_-1px_0_var(--color-line)]">
          <tr>
            {header('key', 'Key', 'w-24 pl-4')}
            {header('title', 'Title')}
            {header('status', 'Status', 'w-40')}
            {header('priority', 'Priority', 'w-24')}
            <th className="w-32 px-2 py-1.5 font-medium">{primaryRole?.name ?? ''}</th>
            {header('due', 'Due', 'w-24')}
            {header('estimate', 'Est.', 'w-16')}
            {header(project.kind === 'queue' ? 'created' : 'updated', project.kind === 'queue' ? 'Opened' : 'Updated', 'w-28 pr-4')}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const status = statusOf(item);
            const done = status?.category === 'done';
            return (
              <tr
                key={item.id}
                onClick={() => onOpenItem(item.id)}
                className={cx(
                  'cursor-pointer border-b border-[var(--color-line)]',
                  item.id === activeItemId ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
                )}
              >
                <td className="whitespace-nowrap py-1.5 pl-4 pr-2 text-xs text-[var(--color-muted)]">
                  <span className="inline-flex items-center gap-1.5">
                    <TypeIcon type={itemTypeOf(project, item.typeId)} />
                    {item.key}
                    {!done && <BlockedBadge count={item.blockedBy} />}
                  </span>
                </td>
                <td className={cx('max-w-0 truncate px-2 py-1.5', done && 'text-[var(--color-muted)] line-through')}>
                  {item.title}
                  {item.commentCount > 0 && (
                    <span className="ml-2 text-xs text-[var(--color-muted)] no-underline">
                      <Icon name="chat-left-text" className="text-[10px]" /> {item.commentCount}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={item.statusId}
                    disabled={!canEdit}
                    onChange={(e) =>
                      update.mutate(
                        { id: item.id, statusId: e.target.value },
                        { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the status', 'error') },
                      )
                    }
                    className="w-full cursor-pointer rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium outline-none hover:border-[var(--color-line)] disabled:cursor-default"
                    style={{ color: status?.color }}
                    aria-label={`Status of ${item.key}`}
                  >
                    {project.statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <PriorityIcon priority={item.priority} />
                </td>
                <td className="px-2 py-1.5">
                  <PeopleStack
                    userIds={primaryRole ? (item.roles[primaryRole.id] ?? []) : []}
                    names={primaryRole?.freeForm ? (item.roleNames[primaryRole.id] ?? []) : []}
                    members={memberMap}
                  />
                </td>
                <td className={cx('whitespace-nowrap px-2 py-1.5 text-xs', isOverdue(item.dueDate, done) ? 'text-red-500' : 'text-[var(--color-muted)]')}>
                  {item.dueDate ? formatDue(item.dueDate) : ''}
                </td>
                <td className="px-2 py-1.5 text-xs tabular-nums text-[var(--color-muted)]">{item.estimate ?? ''}</td>
                <td className="whitespace-nowrap py-1.5 pl-2 pr-4 text-xs text-[var(--color-muted)]">
                  {formatRelative(project.kind === 'queue' ? item.createdAt : item.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="px-4 py-10 text-center text-sm text-[var(--color-muted)]">
          {items.length === 0 ? 'No work items yet.' : 'Nothing matches.'}
        </p>
      )}
      <div className="flex gap-4 px-4 py-3">
        {backlogCount > 0 && (
          <button onClick={() => setShowBacklog(!showBacklog)} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
            {showBacklog ? 'Hide' : 'Show'} {backlogCount} in backlog
          </button>
        )}
        {doneCount > 0 && (
          <button onClick={() => setShowDone(!showDone)} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
            {showDone ? 'Hide' : 'Show'} {doneCount} done
          </button>
        )}
      </div>
    </div>
  );
}
