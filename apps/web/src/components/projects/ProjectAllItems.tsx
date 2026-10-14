import { useCallback, useMemo, useState } from 'react';
import { encodeFilter, isFilterEmpty, type Project, type WorkItemFilter, type WorkItemSummary, type WorkspaceMember } from '@paradocs/shared';
import { useArchivePages } from '../../api/hooks';
import { cx, toISODate, useDebounced } from '../../lib/util';
import ProjectTable, { type ArchiveRows, type ListSettings } from './ProjectTable';

/**
 * Every work item in a project: the current work, already loaded for the
 * board, and beneath it the archive, read a page at a time as the reader
 * scrolls. The archive can run to thousands, so the server filters and orders
 * it — by the same filter box, person and column as the current work — and
 * only what has been scrolled to is ever loaded.
 */
export default function ProjectAllItems({
  project,
  current,
  filter,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  settings,
  onSettings,
}: {
  project: Project;
  /** Current work, already filtered. */
  current: WorkItemSummary[];
  /** What the work is filtered by, which the server applies to the archive. */
  filter: WorkItemFilter;
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  /** The order and grouping, which the List shares. */
  settings: ListSettings;
  onSettings: (settings: ListSettings) => void;
}) {
  const sort = settings.sort;
  const [archivedOnly, setArchivedOnly] = useState(false);
  // Typing asks the server again, so it waits for a pause.
  const f = useDebounced(isFilterEmpty(filter) ? '' : encodeFilter(filter), 300);

  const pages = useArchivePages(
    project.id,
    {
      sort: sort.key,
      descending: String(sort.descending) as 'true' | 'false',
      f: f || undefined,
      // The filter's dates are the reader's own days.
      today: f ? toISODate(new Date()) : undefined,
      tz: f ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
    },
    project.archive.count > 0,
  );
  const { fetchNextPage } = pages;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  const archive = useMemo<ArchiveRows | undefined>(() => {
    if (project.archive.count === 0) return undefined;
    return {
      items: pages.data?.pages.flatMap((page) => page.items) ?? [],
      total: pages.data?.pages[0]?.total ?? null,
      loading: pages.isLoading,
      loadingMore: pages.isFetchingNextPage,
      hasMore: pages.hasNextPage,
      failed: pages.isError,
      onLoadMore: loadMore,
    };
  }, [project.archive.count, pages.data, pages.isLoading, pages.isFetchingNextPage, pages.hasNextPage, pages.isError, loadMore]);

  const option = (value: boolean, label: string) => (
    <button
      key={String(value)}
      role="radio"
      aria-checked={archivedOnly === value}
      onClick={() => setArchivedOnly(value)}
      className={cx(
        'rounded px-2 py-0.5',
        archivedOnly === value ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'hover:text-[var(--color-ink)]',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2 text-xs text-[var(--color-muted)]">
        <div role="radiogroup" aria-label="Show" className="flex rounded-md border border-[var(--color-line)] p-0.5">
          {option(false, `Everything (${project.itemCount.toLocaleString()})`)}
          {option(true, `Archived only (${project.archive.count.toLocaleString()})`)}
        </div>
        <span>
          {project.archiveAfterDays === null
            ? `Finished work in this ${project.kind} is never archived.`
            : `Finished work is archived after ${project.archiveAfterDays} ${project.archiveAfterDays === 1 ? 'day' : 'days'} untouched.`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ProjectTable
          project={project}
          items={archivedOnly ? [] : current}
          memberMap={memberMap}
          canEdit={canEdit}
          activeItemId={activeItemId}
          onOpenItem={onOpenItem}
          sort={sort}
          onSort={(next) => onSettings({ ...settings, sort: next })}
          groupBy={settings.groupBy}
          showEverything
          archive={archive}
        />
      </div>
    </div>
  );
}
