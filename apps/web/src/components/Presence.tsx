import type { PresenceStatus } from '@paradocs/shared';
import { usePresenceSettings, useUpdatePresenceSettings } from '../api/hooks';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { useToast } from './Toast';

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  offline: 'Offline',
};

const DOT_COLOR: Record<PresenceStatus, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-400',
  busy: 'bg-red-500',
  offline: 'bg-zinc-400 dark:bg-zinc-500',
};

const DOT_SIZE = {
  xs: 'h-2 w-2',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
  xl: 'h-4 w-4',
} as const;

export function StatusDot({ status, className }: { status: PresenceStatus; className?: string }) {
  return <span aria-hidden className={cx('inline-block shrink-0 rounded-full', DOT_COLOR[status], className ?? 'h-2 w-2')} />;
}

/**
 * A person's picture with their status in the corner. `ring` is the color of
 * whatever is behind the picture, so the dot reads as cut out of it.
 */
export function PresenceAvatar({
  name,
  url,
  seed,
  size = 'md',
  status,
  ring = 'var(--color-surface)',
  className,
}: {
  name: string;
  url?: string | null;
  seed?: string;
  size?: keyof typeof DOT_SIZE;
  /** Omitted for someone whose status cannot be known, such as a deleted account. */
  status?: PresenceStatus;
  ring?: string;
  className?: string;
}) {
  return (
    <span
      className={cx('relative inline-flex shrink-0', className)}
      title={status ? `${name} · ${STATUS_LABEL[status]}` : undefined}
    >
      <Avatar name={name} url={url} seed={seed} size={size} />
      {status && (
        <span
          aria-hidden
          className={cx('absolute -bottom-0.5 -right-0.5 rounded-full', DOT_SIZE[size], DOT_COLOR[status])}
          style={{ boxShadow: `0 0 0 2px ${ring}` }}
        />
      )}
    </span>
  );
}

export const AWAY_AFTER_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 1, label: '1 minute' },
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 0, label: 'Never' },
];

function awayAfterLabel(minutes: number): string {
  return AWAY_AFTER_CHOICES.find((choice) => choice.minutes === minutes)?.label ?? `${minutes} minutes`;
}

const CHOICES: { status: PresenceStatus; label: string; hint?: string }[] = [
  { status: 'online', label: 'Online' },
  { status: 'away', label: 'Away' },
  { status: 'busy', label: 'Busy', hint: 'Mutes message notifications and call ringing' },
  { status: 'offline', label: 'Appear offline' },
];

export function StatusChoices({
  value,
  onChange,
}: {
  value: PresenceStatus;
  onChange: (status: PresenceStatus) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Status" className="space-y-0.5">
      {CHOICES.map((choice) => {
        const selected = value === choice.status;
        return (
          <button
            key={choice.status}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice.status)}
            className={cx(
              'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left',
              selected ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
            )}
          >
            <StatusDot status={choice.status} className="mt-1.5 h-2.5 w-2.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{choice.label}</span>
              {choice.hint && <span className="block text-[11px] text-[var(--color-muted)]">{choice.hint}</span>}
            </span>
            {selected && <Icon name="check2" className="mt-1 text-[var(--color-accent)]" />}
          </button>
        );
      })}
    </div>
  );
}

export function AwayAfterSelect({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (minutes: number) => void;
  className?: string;
}) {
  // A value set some other way still shows as itself rather than as a wrong choice.
  const choices = AWAY_AFTER_CHOICES.some((choice) => choice.minutes === value)
    ? AWAY_AFTER_CHOICES
    : [{ minutes: value, label: awayAfterLabel(value) }, ...AWAY_AFTER_CHOICES];
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label="Show as away after"
      className={cx(
        'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]',
        className,
      )}
    >
      {choices.map((choice) => (
        <option key={choice.minutes} value={choice.minutes}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

/** Choosing a status and the idle time, wherever they are offered. */
export function useStatusControls() {
  const settings = usePresenceSettings();
  const update = useUpdatePresenceSettings();
  const toast = useToast();
  const current = settings.data ?? { status: 'online' as const, awayAfterMinutes: 10 };

  function change(patch: { status?: PresenceStatus; awayAfterMinutes?: number }) {
    update.mutate(patch, {
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not change your status', 'error'),
    });
  }

  return { current, change };
}

/** The quick status menu: a status, and how long before an online person shows as away. */
export function StatusMenu({ onChosen }: { onChosen?: () => void }) {
  const { current, change } = useStatusControls();
  return (
    <div>
      <StatusChoices
        value={current.status}
        onChange={(status) => {
          change({ status });
          onChosen?.();
        }}
      />
      <label className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--color-line)] px-2 pb-1 pt-2 text-xs">
        <span className="text-[var(--color-muted)]">Show as away after</span>
        <AwayAfterSelect value={current.awayAfterMinutes} onChange={(minutes) => change({ awayAfterMinutes: minutes })} />
      </label>
    </div>
  );
}
