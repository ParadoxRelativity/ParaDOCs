import { useMemo, useState } from 'react';
import {
  type ArchivedTotal,
  UNKNOWN_ITEM_TYPE,
  epicProgress,
  type ItemTypeLook,
  type Project,
  type ProjectKind,
  type ProjectStatus,
  type StatusCategory,
  type WorkItemPriority,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { cx, todayISO, toISODate } from '../../lib/util';
import Avatar from '../Avatar';
import Icon, { type IconName } from '../Icon';
import { Popover } from '../Popover';

/**
 * The small pieces every Projects view draws the same way: statuses, priority,
 * type, and the people on an item.
 */

export const PRIORITY: Record<WorkItemPriority, { label: string; icon: IconName; className: string }> = {
  urgent: { label: 'Urgent', icon: 'exclamation-circle-fill', className: 'text-red-500' },
  high: { label: 'High', icon: 'reception-4', className: 'text-orange-500' },
  medium: { label: 'Medium', icon: 'reception-3', className: 'text-amber-500' },
  low: { label: 'Low', icon: 'reception-1', className: 'text-sky-500' },
  none: { label: 'No priority', icon: 'dash', className: 'text-[var(--color-muted)]' },
};


export const PROJECT_KIND: Record<ProjectKind, { label: string; icon: IconName }> = {
  project: { label: 'Project', icon: 'kanban' },
  queue: { label: 'Queue', icon: 'inboxes' },
};

export const CATEGORY_ICON: Record<StatusCategory, IconName> = {
  backlog: 'inbox',
  todo: 'circle',
  active: 'circle-half',
  done: 'check-circle-fill',
};

/** A project's own icon when it has one, and otherwise a glyph for its kind. */
export function ProjectIcon({ project, className }: { project: { icon: string | null; kind: ProjectKind }; className?: string }) {
  if (project.icon) return <span className={className}>{project.icon}</span>;
  return <Icon name={PROJECT_KIND[project.kind].icon} className={className} />;
}

export function PriorityIcon({ priority, className }: { priority: WorkItemPriority; className?: string }) {
  const { icon, label, className: tone } = PRIORITY[priority];
  return (
    <span title={label} className={cx('inline-flex', tone, className)}>
      <Icon name={icon} />
    </span>
  );
}

/**
 * A work item type's icon in its colour. Takes the type itself, which callers
 * look up in the item's project (`itemTypeOf`) or get alongside it in a listing.
 */
export function TypeIcon({ type, className }: { type: ItemTypeLook | null | undefined; className?: string }) {
  const { icon, name, color } = type ?? UNKNOWN_ITEM_TYPE;
  return (
    <span title={name} className={cx('inline-flex', className)} style={{ color }}>
      <Icon name={icon as IconName} />
    </span>
  );
}

/**
 * How far along an epic is: a bar filled by the share of its work that is
 * done, with the count beside it and the estimates too when any are set.
 */
export function EpicProgressBar({
  project,
  items,
  archived,
  className,
}: {
  project: Pick<Project, 'statuses'>;
  items: Pick<WorkItemSummary, 'statusId' | 'estimate'>[];
  /** What under the epic has been archived, which is done but not among `items`. */
  archived?: ArchivedTotal;
  className?: string;
}) {
  const progress = epicProgress(project, items, archived);
  const share = progress.total === 0 ? 0 : progress.done / progress.total;
  const percent = Math.round(share * 100);
  return (
    <div className={cx('flex items-center gap-2 text-xs text-[var(--color-muted)]', className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Done"
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-[var(--color-line)]"
      >
        <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <span className="shrink-0 tabular-nums">
        {progress.done}/{progress.total} done
        {progress.estimate > 0 && ` · ${progress.doneEstimate}/${progress.estimate} est.`}
      </span>
    </div>
  );
}

/**
 * Says an item is waiting on others: shown while work that blocks it is still
 * open, and never on work that is itself done.
 */
export function BlockedBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      title={`Blocked by ${count} open ${count === 1 ? 'item' : 'items'}`}
      className={cx('inline-flex items-center gap-0.5 text-red-500', className)}
    >
      <Icon name="slash-circle" className="text-[10px]" />
      {count > 1 && <span className="tabular-nums">{count}</span>}
    </span>
  );
}

/** A status as a coloured pill with its category's glyph. */
export function StatusPill({
  status,
  className,
}: {
  status: Pick<ProjectStatus, 'name' | 'color' | 'category'>;
  className?: string;
}) {
  return (
    <span
      className={cx('inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={{ background: `color-mix(in srgb, ${status.color} 16%, transparent)`, color: status.color }}
    >
      <Icon name={CATEGORY_ICON[status.category]} className="text-[10px]" />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

/** A date as a due date reads: "Sep 20", with the year only when it is not this one. */
export function formatDue(date: string): string {
  const value = new Date(`${date}T00:00:00`);
  const sameYear = value.getFullYear() === new Date().getFullYear();
  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Whether a due date has passed, for something not yet done. */
export function isOverdue(date: string | null, done: boolean): boolean {
  if (!date || done) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${date}T00:00:00`) < today;
}

/** Workspace members by id, for drawing people from the ids an item stores. */
export function useMemberMap(members: WorkspaceMember[] | undefined): Map<string, WorkspaceMember> {
  return useMemo(() => new Map((members ?? []).map((m) => [m.userId, m])), [members]);
}

/**
 * Overlapping avatars for whoever holds a role: the members it was given, and
 * then the names typed into it where it is free-form.
 */
export function PeopleStack({
  userIds,
  names = [],
  members,
  max = 3,
  size = 'sm',
}: {
  userIds: string[];
  /** Typed into a free-form role, so there is nobody here to look up. */
  names?: string[];
  members: Map<string, WorkspaceMember>;
  max?: number;
  size?: 'xs' | 'sm' | 'md';
}) {
  const holders = [
    ...userIds.map((id) => {
      const member = members.get(id);
      return { key: id, seed: id, name: member?.name ?? 'Former member', url: member?.avatarUrl };
    }),
    ...names.map((name) => ({ key: `name:${name}`, seed: name, name, url: undefined })),
  ];
  if (holders.length === 0) return null;
  return (
    <span className="flex items-center -space-x-1.5" title={holders.map((h) => h.name).join(', ')}>
      {holders.slice(0, max).map((holder) => (
        <Avatar
          key={holder.key}
          name={holder.name}
          url={holder.url}
          seed={holder.seed}
          size={size}
          className="ring-2 ring-[var(--color-raised)]"
        />
      ))}
      {holders.length > max && <span className="pl-2 text-[10px] text-[var(--color-muted)]">+{holders.length - max}</span>}
    </span>
  );
}

/**
 * How a role's holders read in a line. Several members are a count, since a
 * long list of colleagues says little; anything typed in is spelled out, both
 * because a customer's name is the point and because "2 people" would be wrong
 * about a company.
 */
export function holderLabel(
  userIds: string[],
  names: string[],
  members: Map<string, WorkspaceMember>,
): string {
  const all = [...userIds.map((id) => members.get(id)?.name ?? 'Former member'), ...names];
  if (all.length === 1) return all[0];
  return names.length > 0 ? all.join(', ') : `${all.length} people`;
}

/**
 * Chooses who holds a role. A role for one person closes on the first pick;
 * one for several stays open so people can be ticked in turn. A free-form role
 * also takes whatever is typed, for someone with no account to pick from.
 */
export function PeoplePicker({
  anchor,
  members,
  selected,
  names = [],
  multiple,
  freeForm = false,
  onChange,
  onNamesChange,
  onClose,
}: {
  anchor: HTMLElement;
  members: WorkspaceMember[];
  selected: string[];
  /** The names already typed in, for a free-form role. */
  names?: string[];
  multiple: boolean;
  /** Whether a name can be typed in as well as a member picked. */
  freeForm?: boolean;
  onChange: (userIds: string[]) => void;
  onNamesChange?: (names: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const matches = members.filter(
    (m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle),
  );
  const nameMatches = names.filter((n) => !needle || n.toLowerCase().includes(needle));
  // What is already on the item is offered as itself, not as something to add again.
  const canAdd = freeForm && typed.length > 0 && !names.some((n) => n.toLowerCase() === needle);

  /** Both halves of a role's holders move together, so one pick can clear the other. */
  function set(userIds: string[], nextNames: string[]) {
    onChange(userIds);
    onNamesChange?.(nextNames);
  }

  function toggle(userId: string) {
    if (!multiple) {
      set(selected.includes(userId) ? [] : [userId], []);
      onClose();
      return;
    }
    set(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId], names);
  }

  function addName() {
    if (!canAdd) return;
    if (!multiple) {
      set([], [typed]);
      onClose();
      return;
    }
    set(selected, [...names, typed]);
    setQuery('');
  }

  function removeName(name: string) {
    set(selected, names.filter((n) => n !== name));
    if (!multiple) onClose();
  }

  return (
    <Popover anchor={anchor} placement="below" onClose={onClose} className="w-64 overflow-hidden">
      <div className="border-b border-[var(--color-line)] p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Someone here comes first; a name is what you meant when nobody matched.
            if (matches[0]) {
              e.preventDefault();
              toggle(matches[0].userId);
            } else if (canAdd) {
              e.preventDefault();
              addName();
            }
          }}
          placeholder={freeForm ? 'Find someone, or type a name…' : 'Find someone…'}
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="scroll-thin max-h-64 overflow-y-auto py-1">
        {(selected.length > 0 || names.length > 0) && !multiple && (
          <button
            onClick={() => {
              set([], []);
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
          >
            <Icon name="x-lg" className="w-5 text-center text-xs" /> Nobody
          </button>
        )}
        {canAdd && (
          <button
            onClick={addName}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-surface)]"
          >
            <Icon name="plus-lg" className="w-5 text-center text-xs text-[var(--color-accent)]" />
            <span className="min-w-0 flex-1 truncate">
              Use &ldquo;{typed}&rdquo;
              <span className="text-xs text-[var(--color-muted)]"> — no account needed</span>
            </span>
          </button>
        )}
        {nameMatches.map((name) => (
          <button
            key={`name:${name}`}
            onClick={() => removeName(name)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm font-medium hover:bg-[var(--color-surface)]"
          >
            <Avatar name={name} seed={name} size="sm" />
            <span className="min-w-0 flex-1 truncate">
              {name}
              <span className="text-xs font-normal text-[var(--color-muted)]"> (typed in)</span>
            </span>
            <Icon name="check-lg" className="text-[var(--color-accent)]" />
          </button>
        ))}
        {matches.map((member) => {
          const on = selected.includes(member.userId);
          return (
            <button
              key={member.userId}
              onClick={() => toggle(member.userId)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-surface)]',
                on && 'font-medium',
              )}
            >
              <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="sm" />
              <span className="min-w-0 flex-1 truncate">
                {member.name}
                {member.isSelf && <span className="text-xs font-normal text-[var(--color-muted)]"> (you)</span>}
              </span>
              {on && <Icon name="check-lg" className="text-[var(--color-accent)]" />}
            </button>
          );
        })}
        {matches.length === 0 && nameMatches.length === 0 && !canAdd && (
          <p className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody by that name</p>
        )}
      </div>
    </Popover>
  );
}

/**
 * A due date, chosen from a month calendar that opens under the field. It
 * shows the date as the rest of Projects writes it, and can be cleared.
 */
export function DueDatePicker({
  value,
  onChange,
  disabled,
  overdue,
  placeholder = 'mm/dd/yyyy',
  className,
}: {
  /** YYYY-MM-DD, or null for none. */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  overdue?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-label="Due date"
        className={cx(
          'flex items-center gap-1.5 text-left disabled:cursor-default',
          className,
          overdue && 'text-red-500',
        )}
      >
        <Icon name="calendar-event" className={cx('text-xs', !overdue && 'text-[var(--color-muted)]')} />
        {value ? (
          <span className="truncate">{formatDue(value)}</span>
        ) : (
          <span className="truncate text-[var(--color-muted)]">{placeholder}</span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)} className="w-64 p-2">
          <MonthCalendar
            value={value}
            onPick={(date) => {
              onChange(date);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function MonthCalendar({ value, onPick }: { value: string | null; onPick: (date: string | null) => void }) {
  const today = todayISO();
  const [cursor, setCursor] = useState(() => {
    const shown = new Date(`${value ?? today}T00:00:00`);
    return new Date(shown.getFullYear(), shown.getMonth(), 1);
  });
  // Six weeks from the Sunday on or before the first, so the grid never jumps in height.
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - cursor.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const step = (months: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));
  const nav = 'grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]';

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} className={nav}>
          <Icon name="chevron-left" />
        </button>
        <span className="text-sm font-medium">{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button type="button" aria-label="Next month" onClick={() => step(1)} className={nav}>
          <Icon name="chevron-right" />
        </button>
      </div>
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-[var(--color-muted)]">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((date) => {
          const iso = toISODate(date);
          const inMonth = date.getMonth() === cursor.getMonth();
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              className={cx(
                'aspect-square rounded text-xs',
                !inMonth && 'text-[var(--color-muted)] opacity-50',
                iso === value ? 'bg-[var(--color-accent)] font-semibold text-white' : 'hover:bg-[var(--color-surface)]',
                iso === today && iso !== value && 'font-semibold text-[var(--color-accent)]',
              )}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between border-t border-[var(--color-line)] pt-2 text-xs">
        <button type="button" onClick={() => onPick(today)} className="rounded px-2 py-1 text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
          Today
        </button>
        {value && (
          <button type="button" onClick={() => onPick(null)} className="rounded px-2 py-1 text-[var(--color-muted)] hover:bg-[var(--color-surface)]">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
