import { useMemo, useState } from 'react';
import type { Project, WorkItemSummary, WorkspaceMember } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { PriorityIcon, StatusPill, formatDue, isOverdue } from './projectUi';

interface Load {
  userId: string | null;
  items: WorkItemSummary[];
  notStarted: number;
  inProgress: number;
  estimate: number;
  overdue: number;
}

/**
 * Who has how much on. For one role at a time — usually whoever the work is
 * assigned to, but a team can as easily ask who has the most to review — each
 * person's open items, split into not started and in progress, with their
 * estimates added up and anything overdue called out. Open items nobody holds
 * the role on are gathered at the end, since that is work nobody has yet.
 * The backlog is left out: nobody is working on what has not been planned.
 */
export default function ProjectWorkload({
  project,
  items,
  members,
  memberMap,
  activeItemId,
  onOpenItem,
}: {
  project: Project;
  items: WorkItemSummary[];
  members: WorkspaceMember[];
  memberMap: Map<string, WorkspaceMember>;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
}) {
  const [roleId, setRoleId] = useState(project.roles[0]?.id ?? '');
  const [measure, setMeasure] = useState<'items' | 'estimate'>('items');
  const [expanded, setExpanded] = useState<string | null>(null);
  const role = project.roles.find((r) => r.id === roleId) ?? project.roles[0];
  const statuses = useMemo(() => new Map(project.statuses.map((s) => [s.id, s])), [project.statuses]);

  const loads = useMemo(() => {
    const byUser = new Map<string | null, Load>();
    const loadFor = (userId: string | null) => {
      let load = byUser.get(userId);
      if (!load) {
        load = { userId, items: [], notStarted: 0, inProgress: 0, estimate: 0, overdue: 0 };
        byUser.set(userId, load);
      }
      return load;
    };
    for (const item of items) {
      const status = statuses.get(item.statusId);
      if (!status || status.category === 'done' || status.category === 'backlog') continue;
      const holders = role ? (item.roles[role.id] ?? []) : [];
      for (const userId of holders.length ? holders : [null]) {
        const load = loadFor(userId);
        load.items.push(item);
        if (status.category === 'todo') load.notStarted++;
        else load.inProgress++;
        load.estimate += item.estimate ?? 0;
        if (isOverdue(item.dueDate, false)) load.overdue++;
      }
    }
    const people = [...byUser.values()].filter((load) => load.userId !== null);
    people.sort((a, b) => b.items.length - a.items.length || b.estimate - a.estimate);
    const nobody = byUser.get(null);
    return { people, nobody };
  }, [items, role, statuses]);

  const idle = members.filter((m) => !loads.people.some((load) => load.userId === m.userId));
  const size = (load: Load) => (measure === 'items' ? load.items.length : load.estimate);
  const largest = Math.max(1, ...loads.people.map(size), loads.nobody ? size(loads.nobody) : 0);
  const hasEstimates = items.some((item) => item.estimate !== null);

  function row(load: Load) {
    const key = load.userId ?? 'nobody';
    const member = load.userId ? memberMap.get(load.userId) : undefined;
    const open = expanded === key;
    const total = size(load);
    const started = measure === 'items' ? load.inProgress : load.items.filter((i) => statuses.get(i.statusId)?.category === 'active').reduce((t, i) => t + (i.estimate ?? 0), 0);
    return (
      <li key={key} className="border-b border-[var(--color-line)] last:border-0">
        <button
          onClick={() => setExpanded(open ? null : key)}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface)]"
        >
          <Icon name="chevron-right" className={cx('text-[10px] text-[var(--color-muted)] transition-transform', open && 'rotate-90')} />
          {load.userId ? (
            <Avatar name={member?.name ?? '?'} url={member?.avatarUrl} seed={load.userId} size="lg" />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-full border border-dashed border-[var(--color-line)] text-[var(--color-muted)]">
              <Icon name="person-plus" />
            </span>
          )}
          <span className="w-40 min-w-0 shrink-0">
            <span className="block truncate text-sm font-medium">
              {load.userId ? (member?.name ?? 'Former member') : `No ${role?.name.toLowerCase() ?? 'one'}`}
            </span>
            <span className="block text-xs text-[var(--color-muted)]">
              {load.notStarted} not started · {load.inProgress} in progress
            </span>
          </span>
          <span className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-surface)]" aria-hidden>
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]/35"
              style={{ width: `${(total / largest) * 100}%` }}
            />
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)]"
              style={{ width: `${(started / largest) * 100}%` }}
            />
          </span>
          <span className="w-20 shrink-0 text-right text-sm tabular-nums">
            {measure === 'items' ? `${load.items.length} open` : `${Number(load.estimate.toFixed(2))} est`}
          </span>
          <span className={cx('w-20 shrink-0 text-right text-xs', load.overdue ? 'text-red-500' : 'text-[var(--color-muted)]')}>
            {load.overdue ? `${load.overdue} overdue` : ''}
          </span>
        </button>
        {open && (
          <ul className="pb-2 pl-16 pr-4">
            {load.items.map((item) => {
              const status = statuses.get(item.statusId)!;
              return (
                <li key={item.id}>
                  <button
                    onClick={() => onOpenItem(item.id)}
                    className={cx(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
                      item.id === activeItemId ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
                    )}
                  >
                    <PriorityIcon priority={item.priority} className="w-4 justify-center" />
                    <span className="w-16 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.dueDate && (
                      <span className={cx('text-xs', isOverdue(item.dueDate, false) ? 'text-red-500' : 'text-[var(--color-muted)]')}>
                        {formatDue(item.dueDate)}
                      </span>
                    )}
                    {item.estimate !== null && <span className="text-xs tabular-nums text-[var(--color-muted)]">{item.estimate}</span>}
                    <StatusPill status={status} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  if (!role) {
    return (
      <p className="p-8 text-center text-sm text-[var(--color-muted)]">
        This project has no roles, so there is nobody to show work for. Add one in its settings.
      </p>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">Open work by</span>
          <select
            value={role.id}
            onChange={(e) => setRoleId(e.target.value)}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
            aria-label="Role"
          >
            {project.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="flex-1" />
          {hasEstimates && (
            <div role="radiogroup" aria-label="Measure" className="flex rounded-md border border-[var(--color-line)] p-0.5 text-xs">
              {(['items', 'estimate'] as const).map((option) => (
                <button
                  key={option}
                  role="radio"
                  aria-checked={measure === option}
                  onClick={() => setMeasure(option)}
                  className={cx(
                    'rounded px-2 py-0.5',
                    measure === option ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-muted)]',
                  )}
                >
                  {option === 'items' ? 'Items' : 'Estimates'}
                </button>
              ))}
            </div>
          )}
        </div>

        <ul className="overflow-hidden rounded-xl border border-[var(--color-line)]">
          {loads.people.map(row)}
          {loads.nobody && row(loads.nobody)}
          {loads.people.length === 0 && !loads.nobody && (
            <li className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">No open work.</li>
          )}
        </ul>

        {idle.length > 0 && (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Nothing open as {role.name.toLowerCase()}: {idle.map((m) => m.name).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}
