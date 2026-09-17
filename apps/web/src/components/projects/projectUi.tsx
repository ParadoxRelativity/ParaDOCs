import { useMemo, useState } from 'react';
import type {
  ProjectKind,
  ProjectStatus,
  StatusCategory,
  WorkItemPriority,
  WorkItemType,
  WorkspaceMember,
} from '@paradocs/shared';
import { cx } from '../../lib/util';
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

export const ITEM_TYPE: Record<WorkItemType, { label: string; icon: IconName; className: string }> = {
  task: { label: 'Task', icon: 'check2-square', className: 'text-sky-500' },
  bug: { label: 'Bug', icon: 'bug', className: 'text-red-500' },
  story: { label: 'Story', icon: 'bookmark', className: 'text-emerald-500' },
  epic: { label: 'Epic', icon: 'lightning-charge', className: 'text-violet-500' },
  request: { label: 'Request', icon: 'chat-square-text', className: 'text-amber-500' },
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

export function TypeIcon({ type, className }: { type: WorkItemType; className?: string }) {
  const { icon, label, className: tone } = ITEM_TYPE[type];
  return (
    <span title={label} className={cx('inline-flex', tone, className)}>
      <Icon name={icon} />
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

/** Overlapping avatars for the people holding a role. */
export function PeopleStack({
  userIds,
  members,
  max = 3,
  size = 'sm',
}: {
  userIds: string[];
  members: Map<string, WorkspaceMember>;
  max?: number;
  size?: 'xs' | 'sm' | 'md';
}) {
  if (userIds.length === 0) return null;
  const names = userIds.map((id) => members.get(id)?.name ?? 'Former member');
  return (
    <span className="flex items-center -space-x-1.5" title={names.join(', ')}>
      {userIds.slice(0, max).map((id) => {
        const member = members.get(id);
        return (
          <Avatar
            key={id}
            name={member?.name ?? '?'}
            url={member?.avatarUrl}
            seed={id}
            size={size}
            className="ring-2 ring-[var(--color-raised)]"
          />
        );
      })}
      {userIds.length > max && <span className="pl-2 text-[10px] text-[var(--color-muted)]">+{userIds.length - max}</span>}
    </span>
  );
}

/**
 * Chooses who holds a role. A role for one person closes on the first pick;
 * one for several stays open so people can be ticked in turn.
 */
export function PeoplePicker({
  anchor,
  members,
  selected,
  multiple,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  members: WorkspaceMember[];
  selected: string[];
  multiple: boolean;
  onChange: (userIds: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = members.filter(
    (m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle),
  );

  function toggle(userId: string) {
    if (!multiple) {
      onChange(selected.includes(userId) ? [] : [userId]);
      onClose();
      return;
    }
    onChange(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  }

  return (
    <Popover anchor={anchor} placement="below" onClose={onClose} className="w-64 overflow-hidden">
      <div className="border-b border-[var(--color-line)] p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              e.preventDefault();
              toggle(matches[0].userId);
            }
          }}
          placeholder="Find someone…"
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="scroll-thin max-h-64 overflow-y-auto py-1">
        {selected.length > 0 && !multiple && (
          <button
            onClick={() => {
              onChange([]);
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
          >
            <Icon name="x-lg" className="w-5 text-center text-xs" /> Nobody
          </button>
        )}
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
        {matches.length === 0 && <p className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody by that name</p>}
      </div>
    </Popover>
  );
}
