import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  WORK_ITEM_PRIORITIES,
  groupItems,
  isEpicType,
  itemTypeOf,
  type Project,
  type WorkItemGroupBy,
  type WorkItemSort,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useUpdateWorkItem, useWorkItems } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { cx, formatRelative } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { useStatusComment } from './StatusComment';
import { BlockedBadge, PRIORITY, PeopleStack, PriorityIcon, TypeIcon, formatDue, isOverdue } from './projectUi';

export interface TableSort {
  key: WorkItemSort;
  descending: boolean;
}

/** A queue is worked through oldest first, so that is how it starts; a project starts by number. */
export function defaultSort(project: Pick<Project, 'kind'>): TableSort {
  return project.kind === 'queue' ? { key: 'created', descending: false } : { key: 'key', descending: false };
}

/** How a project's List and All items are ordered and grouped, which each reader keeps for themselves. */
export interface ListSettings {
  sort: TableSort;
  groupBy: WorkItemGroupBy;
}

export function defaultListSettings(project: Pick<Project, 'kind'>): ListSettings {
  return { sort: defaultSort(project), groupBy: 'none' };
}

/**
 * Archived work shown under the current work, a page at a time. It is ordered
 * by the server by the same column as the rest, and the next page is asked for
 * as the reader nears the end of the list.
 */
export interface ArchiveRows {
  items: WorkItemSummary[];
  /** How many archived items match, loaded or not. Null until the first page is in. */
  total: number | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  failed: boolean;
  onLoadMore: () => void;
}

/**
 * Work items as rows, grouped if asked, each group folding away under its
 * heading. Any column header re-sorts, and the status can be changed without
 * opening the item. On a phone the title gets the width:
 * only the key, title, status and the first role keep a column, and the rest
 * goes in a line under the title.
 *
 * All items passes `archive` to list archived work beneath the rest, and
 * controls the order itself, since the server orders the archive.
 */
export default function ProjectTable({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  sort: controlledSort,
  onSort,
  groupBy = 'none',
  showEverything = false,
  archive,
}: {
  project: Project;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  sort?: TableSort;
  onSort?: (sort: TableSort) => void;
  groupBy?: WorkItemGroupBy;
  /** Start with done and backlog work showing, as All items does. */
  showEverything?: boolean;
  archive?: ArchiveRows;
}) {
  const update = useUpdateWorkItem(project.id);
  const toast = useToast();
  const statusComment = useStatusComment(project);
  const mobile = useIsMobile();
  const columns = mobile ? 4 : 8;
  const [ownSort, setOwnSort] = useState<TableSort>(() => defaultSort(project));
  const sort = controlledSort ?? ownSort;
  const setSort = onSort ?? setOwnSort;
  const [showDone, setShowDone] = useState(showEverything || project.kind !== 'queue');
  // Unplanned work stays out of the way unless asked for.
  const [showBacklog, setShowBacklog] = useState(showEverything);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // Epics are named in their groups' headings, whether or not they are in the list.
  const all = useWorkItems(project.id);

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
    const compare: Record<WorkItemSort, (a: WorkItemSummary, b: WorkItemSummary) => number> = {
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

  const grouping = useMemo(() => {
    const epics = (all.data ?? []).filter((item) => isEpicType(project, item.typeId));
    const nameOf = (userId: string) => memberMap.get(userId)?.name ?? 'Former member';
    return (list: WorkItemSummary[]) => groupItems(project, list, groupBy, { epics, nameOf });
  }, [all.data, project, groupBy, memberMap]);

  /** Rows as they are drawn: grouped under folding headings, unless nothing is grouped. */
  function grouped(list: WorkItemSummary[], prefix: string) {
    if (groupBy === 'none') return list.map(row);
    return grouping(list).map((group) => {
      const key = `${prefix}${group.key ?? 'none'}`;
      const closed = folded.has(key);
      return (
        <Fragment key={key}>
          <tr>
            <td colSpan={columns} className="sticky top-8 z-[5] bg-[var(--color-canvas)] p-0">
              <button
                onClick={() =>
                  setFolded((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                aria-expanded={!closed}
                className="flex w-full items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-1.5 text-left text-xs font-semibold"
              >
                <Icon name={closed ? 'chevron-right' : 'chevron-down'} className="text-[10px] text-[var(--color-muted)]" />
                {group.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: group.color }} />}
                <span className={cx('min-w-0 truncate', group.key === null && 'text-[var(--color-muted)]')}>{group.label}</span>
                <span className="font-normal tabular-nums text-[var(--color-muted)]">{group.items.length}</span>
              </button>
            </td>
          </tr>
          {!closed && group.items.map(row)}
        </Fragment>
      );
    });
  }

  /** Moves an item to another status, saying why first when the project asks. */
  async function changeStatus(item: WorkItemSummary, statusId: string) {
    const answer = await statusComment.confirm([{ key: item.key, statusId: item.statusId, toStatusId: statusId }]);
    if (answer === false) return;
    update.mutate(
      { id: item.id, statusId },
      {
        onSuccess: () => void statusComment.comment([item.id], answer),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the status', 'error'),
      },
    );
  }

  function header(key: WorkItemSort, label: string, className?: string) {
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

  function row(item: WorkItemSummary) {
    const status = statusOf(item);
    const done = status?.category === 'done';
    const comments = item.commentCount > 0 && (
      <span className={cx('text-xs text-[var(--color-muted)] no-underline', !mobile && 'ml-2')}>
        <Icon name="chat-left-text" className="text-[10px]" /> {item.commentCount}
      </span>
    );
    return (
      <tr
        key={item.id}
        onClick={() => onOpenItem(item.id)}
        className={cx(
          'cursor-pointer border-b border-[var(--color-line)]',
          item.id === activeItemId ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
        )}
      >
        <td
          className={cx('whitespace-nowrap py-1.5 text-xs text-[var(--color-muted)]', mobile ? 'overflow-hidden pl-3 pr-1 align-top' : 'pl-4 pr-2')}
        >
          {/* On a phone the key goes under its type and badges, to leave the title the width. */}
          <span className={cx('inline-flex gap-1.5', mobile ? 'flex-col-reverse items-start gap-0.5' : 'items-center')}>
            {mobile && <span>{item.key}</span>}
            <span className="inline-flex items-center gap-1.5">
              <TypeIcon type={itemTypeOf(project, item.typeId)} />
              {!mobile && item.key}
              {!done && <BlockedBadge count={item.blockedBy} />}
              {item.archivedAt && (
                <span title={`Archived ${formatRelative(item.archivedAt)}`} className="inline-flex items-center">
                  <Icon name="archive" className="text-[10px]" />
                  <span className="sr-only">Archived</span>
                </span>
              )}
            </span>
          </span>
        </td>
        <td className={cx('px-2 py-1.5', mobile ? 'break-words' : 'max-w-0 truncate')}>
          <span className={cx(mobile && 'line-clamp-3', done && 'text-[var(--color-muted)] line-through')}>{item.title}</span>
          {!mobile && comments}
          {mobile && (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-muted)]">
              {item.priority !== 'none' && (
                <span className="inline-flex items-center gap-1">
                  <PriorityIcon priority={item.priority} />
                  {PRIORITY[item.priority].label}
                </span>
              )}
              {item.dueDate && <span className={cx(isOverdue(item.dueDate, done) && 'text-red-500')}>Due {formatDue(item.dueDate)}</span>}
              {item.estimate !== null && <span className="tabular-nums">Est. {item.estimate}</span>}
              <span>{formatRelative(project.kind === 'queue' ? item.createdAt : item.updatedAt)}</span>
              {comments}
            </span>
          )}
        </td>
        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
          <select
            value={item.statusId}
            disabled={!canEdit}
            onChange={(e) => void changeStatus(item, e.target.value)}
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
        {!mobile && (
          <td className="px-2 py-1.5">
            <PriorityIcon priority={item.priority} />
          </td>
        )}
        <td className={cx('py-1.5', mobile ? 'pl-1 pr-3' : 'px-2')}>
          <PeopleStack
            userIds={primaryRole ? (item.roles[primaryRole.id] ?? []) : []}
            names={primaryRole?.freeForm ? (item.roleNames[primaryRole.id] ?? []) : []}
            members={memberMap}
          />
        </td>
        {!mobile && (
          <>
            <td className={cx('whitespace-nowrap px-2 py-1.5 text-xs', isOverdue(item.dueDate, done) ? 'text-red-500' : 'text-[var(--color-muted)]')}>
              {item.dueDate ? formatDue(item.dueDate) : ''}
            </td>
            <td className="px-2 py-1.5 text-xs tabular-nums text-[var(--color-muted)]">{item.estimate ?? ''}</td>
            <td className="whitespace-nowrap py-1.5 pl-2 pr-4 text-xs text-[var(--color-muted)]">
              {formatRelative(project.kind === 'queue' ? item.createdAt : item.updatedAt)}
            </td>
          </>
        )}
      </tr>
    );
  }

  const archiveEmpty = archive && !archive.loading && archive.items.length === 0;
  const nothing = rows.length === 0 && (!archive || archiveEmpty);

  return (
    <div className="scroll-thin h-full overflow-auto">
      <table className={cx('w-full border-collapse text-sm', mobile ? 'table-fixed' : 'min-w-[760px]')}>
        <thead className="sticky top-0 z-10 bg-[var(--color-canvas)] text-left text-xs text-[var(--color-muted)] shadow-[inset_0_-1px_0_var(--color-line)]">
          {mobile ? (
            <tr className="h-8">
              {header('key', 'Key', 'w-[4.5rem] pl-3')}
              {header('title', 'Title')}
              {header('status', 'Status', 'w-20')}
              <th className="w-10 py-1.5 pl-1 pr-3 font-medium">
                <span className="sr-only">{primaryRole?.name ?? ''}</span>
              </th>
            </tr>
          ) : (
            <tr className="h-8">
              {header('key', 'Key', 'w-24 pl-4')}
              {header('title', 'Title')}
              {header('status', 'Status', 'w-40')}
              {header('priority', 'Priority', 'w-24')}
              <th className="w-32 px-2 py-1.5 font-medium">{primaryRole?.name ?? ''}</th>
              {header('due', 'Due', 'w-24')}
              {header('estimate', 'Est.', 'w-16')}
              {header(project.kind === 'queue' ? 'created' : 'updated', project.kind === 'queue' ? 'Opened' : 'Updated', 'w-28 pr-4')}
            </tr>
          )}
        </thead>
        <tbody>
          {grouped(rows, '')}
          {archive && !archiveEmpty && (
            <>
              <tr>
                <td
                  colSpan={columns}
                  className="bg-[var(--color-surface)] px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]"
                >
                  <Icon name="archive" /> Archived{' '}
                  {archive.total !== null && <span className="font-normal normal-case">{archive.total.toLocaleString()}</span>}
                </td>
              </tr>
              {grouped(archive.items, 'archive:')}
              <ArchiveFooter archive={archive} columns={columns} />
            </>
          )}
        </tbody>
      </table>
      {nothing && (
        <p className="px-4 py-10 text-center text-sm text-[var(--color-muted)]">
          {items.length === 0 && !archive ? 'No work items yet.' : 'Nothing matches.'}
        </p>
      )}
      {(backlogCount > 0 || doneCount > 0) && (
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
      )}
    </div>
  );
}

/**
 * The end of the archived rows: the next page is fetched as this comes into
 * view, with a button for doing it by hand, and what went wrong if it failed.
 */
function ArchiveFooter({ archive, columns }: { archive: ArchiveRows; columns: number }) {
  const ref = useRef<HTMLTableRowElement>(null);
  const { hasMore, loadingMore, failed, onLoadMore } = archive;

  useEffect(() => {
    const element = ref.current;
    if (!element || !hasMore || loadingMore || failed) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), {
      // A screenful early, so scrolling rarely has to wait.
      rootMargin: '0px 0px 600px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, failed, onLoadMore]);

  if (!archive.loading && !hasMore && !failed) return null;
  return (
    <tr ref={ref}>
      <td colSpan={columns} className="px-4 py-3 text-center text-xs text-[var(--color-muted)]">
        {archive.loading || loadingMore ? (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="hourglass-split" /> Loading archived work…
          </span>
        ) : failed ? (
          <button onClick={onLoadMore} className="hover:text-[var(--color-ink)]">
            <Icon name="exclamation-triangle" /> Could not load more. Try again
          </button>
        ) : (
          <button onClick={onLoadMore} className="hover:text-[var(--color-ink)]">
            Load more archived work
          </button>
        )}
      </td>
    </tr>
  );
}
