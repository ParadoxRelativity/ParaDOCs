import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { shiftsAt, type Schedule, type Shift } from '@paradocs/shared';
import { useMembers, useScheduleShifts } from '../../api/hooks';
import { useBackHandler } from '../../lib/back';
import { useIsMobile } from '../../lib/mobile';
import { cx, useLocalStorage } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { Button, IconButton, Spinner } from '../ui';
import {
  formatRange,
  formatTime,
  formatWhen,
  localTimeZone,
  personColor,
  rangeAround,
  stepRange,
  zoneDiffers,
  type RangeKind,
} from './scheduleUi';

type Display = 'timeline' | 'calendar' | 'list';

/** What a view of shifts can do with one, beyond showing it. Overrides and requests add theirs. */
export interface ShiftActions {
  /** Shown when a shift is picked; null when there is nothing to offer for it. */
  render: (shift: Shift, close: () => void) => ReactNode | null;
}

/** The current minute, ticking, so "on now" moves on by itself. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A schedule as it plays out: who is on now, and a day, week or month as a
 * timeline (a row per layer, and the row that counts, with overrides), a
 * month calendar, or a plain list. Times are the viewer's own.
 */
export default function ScheduleView({ schedule, actions }: { schedule: Schedule; actions?: ShiftActions }) {
  const mobile = useIsMobile();
  const now = useNow();
  const people = useMembers(schedule.workspaceId).data ?? [];
  const [kind, setKind] = useLocalStorage<RangeKind>('paradocs.scheduleRange', 'week');
  const [chosenDisplay, setDisplay] = useLocalStorage<Display>('paradocs.scheduleDisplay', 'timeline');
  // A phone has no room for a timeline; the list reads better there.
  const display: Display = mobile && chosenDisplay === 'timeline' ? 'list' : kind !== 'month' && chosenDisplay === 'calendar' ? 'timeline' : chosenDisplay;
  const [anchor, setAnchor] = useState(() => new Date());
  const { from, to } = rangeAround(anchor, kind);
  const shifts = useScheduleShifts(schedule.id, from.toISOString(), to.toISOString());

  // "On now" asks about this minute alone, whatever range is showing.
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const current = useScheduleShifts(schedule.id, minute.toISOString(), new Date(minute.getTime() + 60_000).toISOString());
  const [picked, setPicked] = useState<Shift | null>(null);

  const person = (id: string) => people.find((p) => p.userId === id);
  const name = (id: string | null | undefined) => (id ? (person(id)?.name ?? 'Former member') : '');
  const ownZone = localTimeZone();

  const title =
    kind === 'day'
      ? from.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : kind === 'week'
        ? `${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(to.getTime() - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OnNow
        schedule={schedule}
        shifts={current.data ? shiftsAt(current.data.shifts, now.toISOString()) : null}
        layers={current.data?.layers.map((l) => ({ ...l, shifts: shiftsAt(l.shifts, now.toISOString()) })) ?? []}
        person={person}
        name={name}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
        <div className="flex items-center gap-1">
          <IconButton label="Earlier" onClick={() => setAnchor(stepRange(anchor, kind, -1))}>
            <Icon name="chevron-left" />
          </IconButton>
          <Button variant="subtle" className="py-1 text-xs" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <IconButton label="Later" onClick={() => setAnchor(stepRange(anchor, kind, 1))}>
            <Icon name="chevron-right" />
          </IconButton>
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <Segmented
          label="Range"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'day', label: 'Day' },
            { id: 'week', label: 'Week' },
            { id: 'month', label: 'Month' },
          ]}
        />
        <Segmented
          label="Show as"
          value={display}
          onChange={setDisplay}
          options={[
            ...(mobile ? [] : [{ id: 'timeline' as const, label: 'Timeline', icon: 'bar-chart-steps' as const }]),
            ...(kind === 'month' ? [{ id: 'calendar' as const, label: 'Calendar', icon: 'calendar3' as const }] : []),
            { id: 'list', label: 'List', icon: 'list-ul' },
          ]}
        />
      </div>

      {zoneDiffers(schedule.timeZone) && (
        <p className="shrink-0 border-b border-[var(--color-line)] px-4 py-1 text-[11px] text-[var(--color-muted)]">
          Times are in your zone, {ownZone.replace(/_/g, ' ')}. This schedule runs on {schedule.timeZone.replace(/_/g, ' ')}.
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {!shifts.data ? (
          <Spinner />
        ) : display === 'timeline' ? (
          <Timeline data={shifts.data} from={from} to={to} kind={kind} now={now} name={name} onPick={setPicked} />
        ) : display === 'calendar' ? (
          <MonthGrid shifts={shifts.data.shifts} from={from} to={to} now={now} name={name} onPick={setPicked} />
        ) : (
          <ShiftList shifts={shifts.data.shifts} name={name} person={person} onPick={setPicked} />
        )}
      </div>

      {picked && (
        <ShiftDetail
          shift={picked}
          name={name}
          schedule={schedule}
          extra={actions?.render(picked, () => setPicked(null)) ?? null}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: 'bar-chart-steps' | 'calendar3' | 'list-ul' }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-[var(--color-line)] p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            'flex items-center gap-1 rounded px-2 py-0.5 text-xs',
            value === option.id ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
          )}
        >
          {option.icon && <Icon name={option.icon} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Who is on right now, overall and on each layer, and until when. */
function OnNow({
  schedule,
  shifts,
  layers,
  person,
  name,
}: {
  schedule: Schedule;
  shifts: Shift[] | null;
  layers: { lineageId: string; name: string; shifts: Shift[] }[];
  person: (id: string) => { avatarUrl: string | null } | undefined;
  name: (id: string | null | undefined) => string;
}) {
  if (!shifts) return null;
  return (
    <div className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface)]/50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">On now</span>
        {shifts.length === 0 && <span className="text-sm text-[var(--color-muted)]">Nobody</span>}
        {shifts.map((shift) => (
          <span key={`${shift.userId}-${shift.start}`} className="flex items-center gap-1.5 text-sm">
            <Avatar name={name(shift.userId)} url={person(shift.userId)?.avatarUrl} seed={shift.userId} size="sm" />
            <span className="font-medium">{name(shift.userId)}</span>
            {shift.overriddenFrom && <span className="text-xs text-[var(--color-muted)]">for {name(shift.overriddenFrom)}</span>}
            <span className="text-xs text-[var(--color-muted)]">until {formatWhen(shift.end)}</span>
          </span>
        ))}
      </div>
      {layers.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--color-muted)]">
          {layers.map((layer) => (
            <span key={layer.lineageId}>
              {layer.name}: {layer.shifts.length ? layer.shifts.map((s) => name(s.userId)).join(', ') : 'nobody'}
            </span>
          ))}
        </div>
      )}
      {schedule.layers.length === 0 && (
        <p className="text-xs text-[var(--color-muted)]">This schedule has no layers yet. Add one under Layers.</p>
      )}
    </div>
  );
}

/** A bar's look: a person's color, with an override hatched so it stands out. */
function barStyle(shift: Shift): React.CSSProperties {
  const color = personColor(shift.userId);
  return shift.overrideId
    ? {
        background: `repeating-linear-gradient(135deg, ${color}, ${color} 6px, color-mix(in srgb, ${color} 70%, white) 6px, color-mix(in srgb, ${color} 70%, white) 12px)`,
        outline: '2px dashed var(--color-ink)',
        outlineOffset: '-2px',
      }
    : { background: color };
}

function shiftTitle(shift: Shift, name: (id: string | null | undefined) => string): string {
  const covering = shift.overriddenFrom ? ` covering for ${name(shift.overriddenFrom)}` : shift.overrideId ? ' (extra cover)' : '';
  return `${name(shift.userId)}${covering}${shift.label ? ` · ${shift.label}` : ''}\n${formatRange(shift.start, shift.end)}`;
}

/** A row per layer and the row that counts, across the range. */
function Timeline({
  data,
  from,
  to,
  kind,
  now,
  name,
  onPick,
}: {
  data: { shifts: Shift[]; layers: { lineageId: string; name: string; shifts: Shift[] }[] };
  from: Date;
  to: Date;
  kind: RangeKind;
  now: Date;
  name: (id: string | null | undefined) => string;
  onPick: (shift: Shift) => void;
}) {
  const span = to.getTime() - from.getTime();
  const at = (t: number) => `${(Math.min(Math.max(t - from.getTime(), 0), span) / span) * 100}%`;
  const ticks = useMemo(() => {
    const list: { at: number; label: string }[] = [];
    if (kind === 'day') {
      for (let h = 0; h < 24; h += 3) {
        const t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h);
        list.push({ at: t.getTime(), label: t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
      }
    } else {
      for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        list.push({
          at: d.getTime(),
          label: kind === 'week' ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : String(d.getDate()),
        });
      }
    }
    return list;
  }, [from, to, kind]);
  const minWidth = kind === 'day' ? 640 : kind === 'week' ? 760 : 1100;
  const rows = [{ key: 'final', name: 'Who is on', shifts: data.shifts, final: true }, ...data.layers.map((l) => ({ key: l.lineageId, name: l.name, shifts: l.shifts, final: false }))];
  const nowShown = now >= from && now < to;

  const bar = (shift: Shift, i: number) => {
    const start = Date.parse(shift.start);
    const end = Date.parse(shift.end);
    const left = at(start);
    const width = `calc(${at(end)} - ${left})`;
    return (
      <button
        key={i}
        title={shiftTitle(shift, name)}
        onClick={() => onPick(shift)}
        className="absolute top-1 bottom-1 overflow-hidden rounded px-1 text-left text-[11px] font-medium text-white"
        style={{ left, width, ...barStyle(shift) }}
      >
        <span className="block truncate">
          {shift.overrideId && <Icon name="arrow-left-right" />} {name(shift.userId)}
        </span>
      </button>
    );
  };

  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className="min-w-full" style={{ minWidth }}>
        <div className="sticky top-0 z-10 flex border-b border-[var(--color-line)] bg-[var(--color-canvas)]">
          <div className="w-32 shrink-0" />
          <div className="relative h-6 flex-1">
            {ticks.map((tick) => (
              <span key={tick.at} className="absolute top-1 -translate-x-0 pl-1 text-[10px] text-[var(--color-muted)]" style={{ left: at(tick.at) }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>
        {rows.map((row) => (
          <div key={row.key} className={cx('flex border-b border-[var(--color-line)]', row.final && 'bg-[var(--color-surface)]/40')}>
            <div className={cx('w-32 shrink-0 truncate px-3 py-2 text-xs', row.final ? 'font-semibold' : 'text-[var(--color-muted)]')}>{row.name}</div>
            <div className="relative h-9 flex-1">
              {ticks.map((tick) => (
                <span key={tick.at} className="absolute top-0 bottom-0 border-l border-[var(--color-line)]/60" style={{ left: at(tick.at) }} />
              ))}
              {row.shifts.map(bar)}
              {nowShown && <span className="absolute top-0 bottom-0 w-px bg-red-500" style={{ left: at(now.getTime()) }} />}
            </div>
          </div>
        ))}
        {rows.length === 1 && data.shifts.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">Nobody is on in this stretch.</p>
        )}
      </div>
    </div>
  );
}

/** A month as a calendar, each day listing who is on during it. */
function MonthGrid({
  shifts,
  from,
  to,
  now,
  name,
  onPick,
}: {
  shifts: Shift[];
  from: Date;
  to: Date;
  now: Date;
  name: (id: string | null | undefined) => string;
  onPick: (shift: Shift) => void;
}) {
  const first = new Date(from.getFullYear(), from.getMonth(), from.getDate() - ((from.getDay() + 6) % 7));
  const days: Date[] = [];
  for (let d = first; d < to || days.length % 7; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d);
  const today = now.toDateString();

  return (
    <div className="scroll-thin h-full overflow-auto p-2">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-line)]">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="bg-[var(--color-canvas)] px-1.5 py-1 text-[10px] font-semibold uppercase text-[var(--color-muted)]">
            {d}
          </div>
        ))}
        {days.map((day) => {
          const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
          const on = shifts.filter((s) => Date.parse(s.start) < next.getTime() && Date.parse(s.end) > day.getTime());
          const inMonth = day.getMonth() === from.getMonth();
          return (
            <div key={day.toISOString()} className={cx('min-h-20 bg-[var(--color-canvas)] p-1', !inMonth && 'opacity-50')}>
              <div className={cx('mb-0.5 text-[11px]', day.toDateString() === today ? 'font-bold text-[var(--color-accent)]' : 'text-[var(--color-muted)]')}>
                {day.getDate()}
              </div>
              {on.slice(0, 4).map((shift, i) => (
                <button
                  key={i}
                  onClick={() => onPick(shift)}
                  title={shiftTitle(shift, name)}
                  className="mb-0.5 block w-full truncate rounded px-1 text-left text-[10px] text-white"
                  style={barStyle(shift)}
                >
                  {Date.parse(shift.start) >= day.getTime() ? `${formatTime(shift.start)} ` : ''}
                  {name(shift.userId)}
                </button>
              ))}
              {on.length > 4 && <div className="text-[10px] text-[var(--color-muted)]">+{on.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Shifts one after another, by the day they start. */
export function ShiftList({
  shifts,
  name,
  person,
  onPick,
  scheduleOf,
}: {
  shifts: Shift[];
  name: (id: string | null | undefined) => string;
  person: (id: string) => { avatarUrl: string | null } | undefined;
  onPick: (shift: Shift) => void;
  /** For a list across schedules: which one each shift is on. */
  scheduleOf?: (shift: Shift) => { name: string; color: string };
}) {
  const days = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const key = new Date(shift.start).toDateString();
    days.set(key, [...(days.get(key) ?? []), shift]);
  }
  if (shifts.length === 0) return <p className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">Nobody is on in this stretch.</p>;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      {[...days].map(([day, list]) => (
        <section key={day}>
          <h3 className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            {new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </h3>
          <ul>
            {list.map((shift, i) => {
              const schedule = scheduleOf?.(shift);
              return (
                <li key={i}>
                  <button onClick={() => onPick(shift)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--color-surface)]">
                    <span className="h-8 w-1 shrink-0 rounded" style={barStyle(shift)} />
                    <Avatar name={name(shift.userId)} url={person(shift.userId)?.avatarUrl} seed={shift.userId} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {schedule ? schedule.name : name(shift.userId)}
                        {shift.label && <span className="font-normal text-[var(--color-muted)]"> · {shift.label}</span>}
                      </span>
                      <span className="block truncate text-xs text-[var(--color-muted)]">
                        {formatRange(shift.start, shift.end)}
                        {shift.overriddenFrom && ` · covering for ${name(shift.overriddenFrom)}`}
                        {!shift.overriddenFrom && shift.overrideId && ' · extra cover'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One shift, picked from a view: who, when, and whatever can be done with it. */
function ShiftDetail({
  shift,
  name,
  schedule,
  extra,
  onClose,
}: {
  shift: Shift;
  name: (id: string | null | undefined) => string;
  schedule: Schedule;
  extra: ReactNode | null;
  onClose: () => void;
}) {
  // Back closes it, as it would a dialog.
  useBackHandler(onClose);
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-canvas)] px-4 py-3 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 sm:rounded-lg sm:border">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={barStyle(shift)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {name(shift.userId)}
            {shift.label && <span className="font-normal text-[var(--color-muted)]"> · {shift.label}</span>}
          </p>
          <p className="text-xs text-[var(--color-muted)]">{formatRange(shift.start, shift.end)}</p>
          {zoneDiffers(schedule.timeZone) && (
            <p className="text-xs text-[var(--color-muted)]">{formatRange(shift.start, shift.end, schedule.timeZone)} schedule time</p>
          )}
          {shift.overriddenFrom && <p className="mt-1 text-xs">Covering for {name(shift.overriddenFrom)}</p>}
          {!shift.overriddenFrom && shift.overrideId && <p className="mt-1 text-xs">Extra cover</p>}
        </div>
        <IconButton label="Close" onClick={onClose}>
          <Icon name="x-lg" />
        </IconButton>
      </div>
      {extra && <div className="mt-2">{extra}</div>}
    </div>
  );
}
