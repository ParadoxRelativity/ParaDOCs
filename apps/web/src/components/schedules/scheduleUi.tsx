import { useMemo, useState } from 'react';
import { SCHEDULE_COLORS, type WorkspaceMember } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';
import Icon, { type IconName } from '../Icon';
import { FIELD } from '../SettingsParts';

/** A schedule's color, as a dot beside its name. */
export function ScheduleDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

/** The viewer's own zone: where a new schedule starts. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Every zone this browser knows, for picking one. */
export function timeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
  return supported?.length ? supported : [localTimeZone(), 'UTC'];
}

export function TimeZoneSelect({ value, onChange, disabled }: { value: string; onChange: (zone: string) => void; disabled?: boolean }) {
  const zones = useMemo(() => {
    const all = timeZones();
    return all.includes(value) ? all : [value, ...all];
  }, [value]);
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx(FIELD, 'mt-1')}>
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

export function ColorPicker({ value, onChange, disabled }: { value: string; onChange: (color: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Color" className="mt-1 flex flex-wrap gap-1.5">
      {SCHEDULE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          disabled={disabled}
          onClick={() => onChange(color)}
          className={cx(
            'h-6 w-6 rounded-full border-2',
            value === color ? 'border-[var(--color-ink)]' : 'border-transparent',
          )}
          style={{ background: color }}
        />
      ))}
    </div>
  );
}

/** A switch with its label and hint, for settings that are on or off. */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-[var(--color-muted)]">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[1.125rem]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

export interface PickedMember {
  userId: string;
  manager: boolean;
}

/**
 * Who is on a schedule, chosen from the workspace's members, and which of them
 * manage it. Searchable, since a workspace can be large.
 */
export function MemberPicker({
  members,
  value,
  onChange,
  disabled,
}: {
  members: WorkspaceMember[];
  value: PickedMember[];
  onChange: (value: PickedMember[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const picked = new Map(value.map((m) => [m.userId, m]));
  const needle = search.trim().toLowerCase();
  const shown = members
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.email?.toLowerCase().includes(needle))
    // Who is on it first, so the list reads as the schedule.
    .sort((a, b) => Number(picked.has(b.userId)) - Number(picked.has(a.userId)) || a.name.localeCompare(b.name));

  const toggle = (userId: string) =>
    onChange(picked.has(userId) ? value.filter((m) => m.userId !== userId) : [...value, { userId, manager: false }]);
  const setManager = (userId: string, manager: boolean) =>
    onChange(value.map((m) => (m.userId === userId ? { ...m, manager } : m)));

  return (
    <div className="rounded-lg border border-[var(--color-line)]">
      <div className="border-b border-[var(--color-line)] p-1.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find people"
          aria-label="Find people"
          className={FIELD}
        />
      </div>
      <ul className="scroll-thin max-h-56 overflow-y-auto py-1">
        {shown.map((member) => {
          const on = picked.get(member.userId);
          return (
            <li key={member.userId} className="flex items-center gap-2 px-2 py-1">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(on)}
                  disabled={disabled}
                  onChange={() => toggle(member.userId)}
                />
                <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="sm" />
                <span className="truncate">{member.name}</span>
              </label>
              {on && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={on.manager}
                  onClick={() => setManager(member.userId, !on.manager)}
                  title="Managers edit the schedule, override its shifts and approve its swaps"
                  className={cx(
                    'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
                    on.manager
                      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  <Icon name="star" /> {on.manager ? 'Manager' : 'Make manager'}
                </button>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody matches.</li>}
      </ul>
    </div>
  );
}

/**
 * A schedule's views as tabs. On a phone they take a row of their own and
 * scroll sideways. Arrow keys move between them.
 */
export function ViewTabs<V extends string>({
  views,
  view,
  onChange,
  mobile = false,
}: {
  views: { id: V; label: string; icon: IconName }[];
  view: V;
  onChange: (view: V) => void;
  mobile?: boolean;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const index = views.findIndex((v) => v.id === view);
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = views[(next + views.length) % views.length];
    onChange(target.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-view="${target.id}"]`)?.focus();
  }
  return (
    <div
      role="tablist"
      aria-label="Views"
      onKeyDown={onKeyDown}
      className={cx(
        'flex rounded-md border border-[var(--color-line)] p-0.5',
        mobile ? 'scroll-none w-full overflow-x-auto' : 'ml-2',
      )}
    >
      {views.map((option) => (
        <button
          key={option.id}
          role="tab"
          data-view={option.id}
          aria-selected={view === option.id}
          tabIndex={view === option.id ? 0 : -1}
          onClick={() => onChange(option.id)}
          className={cx(
            'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs',
            mobile ? 'py-1.5' : 'py-0.5',
            view === option.id
              ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
              : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
          )}
        >
          <Icon name={option.icon} />
          {option.label}
        </button>
      ))}
    </div>
  );
}
