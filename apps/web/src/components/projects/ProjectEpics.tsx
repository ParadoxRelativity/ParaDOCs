import { useMemo } from 'react';
import {
  isEpicType,
  itemTypeOf,
  usesSprints,
  type Project,
  type ProjectStatus,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useUpdateWorkItem } from '../../api/hooks';
import { cx, useLocalStorage } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { Button, EmptyState } from '../ui';
import { BlockedBadge, EpicProgressBar, PeopleStack, PriorityIcon, StatusPill, TypeIcon, formatDue, isOverdue } from './projectUi';

/**
 * A project's epics and the work organised under each: how far along every
 * objective is, what is left in it, and what belongs to none yet.
 *
 * Epics are kept off the board and out of sprints, since nobody works on an
 * epic itself; this is where they are followed. The work under them is worked
 * wherever it is — the board, a sprint, the backlog — and shown here as well.
 */
export default function ProjectEpics({
  project,
  items,
  visible,
  filtering,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  onNewItem,
}: {
  project: Project;
  /** Every item in the project, to find each epic and its work. */
  items: WorkItemSummary[];
  /** The ones the filter lets through. */
  visible: WorkItemSummary[];
  filtering: boolean;
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onNewItem: (options: { typeId?: string; epicId?: string }) => void;
}) {
  const update = useUpdateWorkItem(project.id);
  const toast = useToast();
  const [showCompleted, setShowCompleted] = useLocalStorage(`paradocs.epicsShowCompleted.${project.id}`, false);
  const [folded, setFolded] = useLocalStorage<string[]>(`paradocs.epicsFolded.${project.id}`, []);

  const statuses = useMemo(() => new Map(project.statuses.map((s) => [s.id, s])), [project.statuses]);
  const isDone = (item: WorkItemSummary) => statuses.get(item.statusId)?.category === 'done';
  const isEpic = (item: WorkItemSummary) => isEpicType(project, item.typeId);
  const epicType = project.itemTypes.find((t) => t.epic);

  const { epics, loose, completedCount } = useMemo(() => {
    const shown = new Set(visible.map((item) => item.id));
    const children = new Map<string, WorkItemSummary[]>();
    const unassigned: WorkItemSummary[] = [];
    for (const item of items) {
      if (isEpic(item) || !shown.has(item.id)) continue;
      if (item.epicId) {
        const list = children.get(item.epicId);
        if (list) list.push(item);
        else children.set(item.epicId, [item]);
      } else if (statuses.get(item.statusId)?.category !== 'done') {
        unassigned.push(item);
      }
    }
    const byNumber = (a: WorkItemSummary, b: WorkItemSummary) => a.number - b.number;
    const all = items
      .filter(isEpic)
      .map((epic) => ({ epic, children: (children.get(epic.id) ?? []).sort(byNumber) }))
      // A filter keeps an epic that matches it, or has work under it that does.
      .filter(({ epic, children: own }) => !filtering || shown.has(epic.id) || own.length > 0)
      .sort((a, b) => byNumber(a.epic, b.epic));
    const completed = all.filter(({ epic }) => statuses.get(epic.statusId)?.category === 'done');
    return {
      epics: showCompleted ? all : all.filter(({ epic }) => statuses.get(epic.statusId)?.category !== 'done'),
      loose: unassigned.sort(byNumber),
      completedCount: completed.length,
    };
    // isEpic reads only the project's types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, visible, filtering, statuses, showCompleted, project.itemTypes]);

  const openEpics = items.filter((item) => isEpic(item) && !isDone(item));

  function toggle(key: string) {
    setFolded((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  }

  function assign(item: WorkItemSummary, epicId: string | null) {
    const epic = epicId ? items.find((other) => other.id === epicId) : null;
    update.mutate(
      { id: item.id, epicId },
      {
        onSuccess: () => toast(epic ? `${item.key} is now under ${epic.key}` : `${item.key} is out of its epic`),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the work item', 'error'),
      },
    );
  }

  const noEpicsYet = !items.some(isEpic);

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">
            Epics <span className="font-normal text-[var(--color-muted)]">{epics.length}</span>
          </h2>
          {completedCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
              Show completed ({completedCount})
            </label>
          )}
          {canEdit && !project.archivedAt && epicType && (
            <Button variant="subtle" className="text-xs" onClick={() => onNewItem({ typeId: epicType.id })}>
              <Icon name="plus-lg" /> New {epicType.name.toLowerCase()}
            </Button>
          )}
        </div>

        {noEpicsYet ? (
          <div className="rounded-xl border border-dashed border-[var(--color-line)]">
            <EmptyState
              icon="lightning-charge"
              title="No epics yet"
              hint="An epic is a larger objective. Put stories, tasks and bugs under it to follow how far along it is. Epics stay off the board and out of sprints; the work under them goes in."
            />
          </div>
        ) : epics.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--color-line)] px-4 py-6 text-center text-sm text-[var(--color-muted)]">
            {filtering ? 'No epics match the filter.' : 'Every epic is complete.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {epics.map(({ epic, children }) => {
              const open = !folded.includes(epic.id);
              const status = statuses.get(epic.statusId);
              return (
                <li
                  key={epic.id}
                  className={cx(
                    'overflow-hidden rounded-xl border border-[var(--color-line)]',
                    activeItemId === epic.id && 'border-[var(--color-accent)]',
                  )}
                >
                  <div className="flex items-start gap-2 px-3 py-2.5">
                    <button
                      onClick={() => toggle(epic.id)}
                      aria-expanded={open}
                      aria-label={open ? `Fold ${epic.key}` : `Unfold ${epic.key}`}
                      className="mt-0.5 rounded p-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                    >
                      <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <button onClick={() => onOpenItem(epic.id)} className="flex w-full items-center gap-2 text-left">
                        <TypeIcon type={itemTypeOf(project, epic.typeId)} />
                        <span className="shrink-0 text-xs text-[var(--color-muted)]">{epic.key}</span>
                        <span className={cx('min-w-0 flex-1 truncate text-sm font-medium hover:underline', status?.category === 'done' && 'text-[var(--color-muted)] line-through')}>
                          {epic.title}
                        </span>
                        {epic.dueDate && (
                          <span className={cx('shrink-0 text-xs', isOverdue(epic.dueDate, status?.category === 'done') ? 'text-red-500' : 'text-[var(--color-muted)]')}>
                            {formatDue(epic.dueDate)}
                          </span>
                        )}
                        {status && <StatusPill status={status} className="shrink-0" />}
                      </button>
                      <EpicProgressBar project={project} items={children} className="mt-2" />
                    </div>
                  </div>
                  {open && (
                    <div className="border-t border-[var(--color-line)] bg-[var(--color-surface)]/40">
                      {children.length === 0 ? (
                        <p className="px-4 py-2.5 text-xs text-[var(--color-muted)]">
                          {filtering ? 'Nothing under this epic matches the filter.' : 'No work under this epic yet.'}
                        </p>
                      ) : (
                        <ul className="divide-y divide-[var(--color-line)]">
                          {children.map((child) => (
                            <ChildRow
                              key={child.id}
                              project={project}
                              item={child}
                              status={statuses.get(child.statusId)}
                              memberMap={memberMap}
                              active={activeItemId === child.id}
                              onOpen={() => onOpenItem(child.id)}
                              action={
                                canEdit ? (
                                  <button
                                    onClick={() => assign(child, null)}
                                    title={`Take ${child.key} out of this epic`}
                                    aria-label={`Take ${child.key} out of this epic`}
                                    className="rounded p-1 text-xs text-[var(--color-muted)] opacity-0 hover:text-[var(--color-ink)] focus:opacity-100 group-hover:opacity-100"
                                  >
                                    <Icon name="x-lg" />
                                  </button>
                                ) : null
                              }
                            />
                          ))}
                        </ul>
                      )}
                      {canEdit && !project.archivedAt && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] px-4 py-2">
                          <button
                            onClick={() => onNewItem({ epicId: epic.id })}
                            className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                          >
                            <Icon name="plus-lg" /> New work in this epic
                          </button>
                          {loose.length > 0 && (
                            <select
                              value=""
                              onChange={(e) => {
                                const item = loose.find((other) => other.id === e.target.value);
                                if (item) assign(item, epic.id);
                              }}
                              className="ml-auto max-w-[16rem] rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
                              aria-label={`Add existing work to ${epic.key}`}
                            >
                              <option value="">Add existing work…</option>
                              {loose.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.key} {item.title}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {loose.length > 0 && !noEpicsYet && (
          <section className="mt-6">
            <button
              onClick={() => toggle('__loose')}
              aria-expanded={!folded.includes('__loose')}
              className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              <Icon name={folded.includes('__loose') ? 'chevron-right' : 'chevron-down'} />
              Not in an epic <span className="font-normal normal-case">{loose.length} open</span>
            </button>
            {!folded.includes('__loose') && (
              <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-[var(--color-line)]">
                {loose.map((item) => (
                  <ChildRow
                    key={item.id}
                    project={project}
                    item={item}
                    status={statuses.get(item.statusId)}
                    memberMap={memberMap}
                    active={activeItemId === item.id}
                    onOpen={() => onOpenItem(item.id)}
                    action={
                      canEdit && openEpics.length > 0 ? (
                        <select
                          value=""
                          onChange={(e) => e.target.value && assign(item, e.target.value)}
                          className="w-28 shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
                          aria-label={`Put ${item.key} under an epic`}
                        >
                          <option value="">Move to…</option>
                          {openEpics.map((epic) => (
                            <option key={epic.id} value={epic.id}>
                              {epic.key} {epic.title}
                            </option>
                          ))}
                        </select>
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ChildRow({
  project,
  item,
  status,
  memberMap,
  active,
  onOpen,
  action,
}: {
  project: Project;
  item: WorkItemSummary;
  status: ProjectStatus | undefined;
  memberMap: Map<string, WorkspaceMember>;
  active: boolean;
  onOpen: () => void;
  action: React.ReactNode;
}) {
  const done = status?.category === 'done';
  const sprint = usesSprints(project) && item.sprintId ? project.sprints.find((s) => s.id === item.sprintId) : null;
  const primaryRole = project.roles[0];
  const holders = primaryRole ? (item.roles[primaryRole.id] ?? []) : [];
  const names = primaryRole ? (item.roleNames[primaryRole.id] ?? []) : [];
  return (
    <li className={cx('group flex items-center gap-2 px-4 py-1.5', active && 'bg-[var(--color-accent-soft)]')}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
        <TypeIcon type={itemTypeOf(project, item.typeId)} />
        <PriorityIcon priority={item.priority} className="w-4 justify-center" />
        <span className="w-16 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
        <span className={cx('min-w-0 flex-1 truncate hover:underline', done && 'text-[var(--color-muted)] line-through')}>{item.title}</span>
        {!done && <BlockedBadge count={item.blockedBy} className="text-xs" />}
        {sprint && (
          <span className="hidden shrink-0 rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)] sm:inline">
            {sprint.name}
          </span>
        )}
        {holders.length + names.length > 0 && <PeopleStack userIds={holders} names={names} members={memberMap} />}
        {item.estimate !== null && <span className="w-8 shrink-0 text-right text-xs tabular-nums text-[var(--color-muted)]">{item.estimate}</span>}
        {status && <StatusPill status={status} className="w-28 shrink-0 justify-center" />}
      </button>
      {action}
    </li>
  );
}
