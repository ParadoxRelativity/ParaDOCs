import { useMemo } from 'react';
import { resolveLayers, type RecurringConfig, type RecurringEntry, type OneOffShift } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { FIELD_BASE } from '../SettingsParts';
import { Button, IconButton } from '../ui';
import { todayIn, type KindFieldsProps } from './LayerEditor';
import { DayPicker, formatRange, zoneDiffers } from './scheduleUi';

const newId = (prefix: string, taken: string[]) => {
  for (let i = 1; ; i += 1) if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;
};

/**
 * Regular hours: each person's weekly pattern, between optional dates, and
 * single shifts on top. Several people can be on at once. The same person on
 * twice at once is allowed, but pointed out.
 */
export function RecurringFields({ schedule, draft, people, onChange }: KindFieldsProps) {
  const config = draft.config as RecurringConfig;
  const setConfig = (patch: Partial<RecurringConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const setEntry = (index: number, patch: Partial<RecurringEntry>) =>
    setConfig({ entries: config.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  const setOneOff = (index: number, patch: Partial<OneOffShift>) =>
    setConfig({ oneOffs: config.oneOffs.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const onSchedule = new Set(schedule.members.map((m) => m.userId));
  const choices = [...people].sort((a, b) => Number(onSchedule.has(b.userId)) - Number(onSchedule.has(a.userId)) || a.name.localeCompare(b.name));
  const name = (id: string) => people.find((p) => p.userId === id)?.name ?? 'Former member';
  const zone = zoneDiffers(schedule.timeZone) ? schedule.timeZone : undefined;

  // The same person on twice at once over the next four weeks.
  const clashes = useMemo(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 28 * 86_400_000).toISOString();
    const shifts =
      resolveLayers(
        schedule,
        [{ id: 'x', lineageId: 'x', kind: 'recurring', position: 0, config, effectiveFrom: from, effectiveUntil: null, members: [] }],
        from,
        to,
      ).get('x') ?? [];
    const found: { userId: string; start: string; end: string }[] = [];
    for (let i = 0; i < shifts.length; i += 1) {
      for (let j = i + 1; j < shifts.length; j += 1) {
        const a = shifts[i];
        const b = shifts[j];
        if (a.userId === b.userId && a.start < b.end && b.start < a.end) {
          found.push({ userId: a.userId, start: a.start > b.start ? a.start : b.start, end: a.end < b.end ? a.end : b.end });
        }
      }
    }
    return found;
  }, [schedule, config]);

  const personSelect = (value: string, onPick: (userId: string) => void) => (
    <select value={value} onChange={(e) => onPick(e.target.value)} className={cx(FIELD_BASE, 'w-36 py-1 text-xs')} aria-label="Person">
      {!value && <option value="">Choose…</option>}
      {choices.map((p) => (
        <option key={p.userId} value={p.userId}>
          {p.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="text-xs text-[var(--color-muted)]">
        <span className="mb-1 block">Weekly hours</span>
        <div className="space-y-2">
          {config.entries.map((entry, index) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-line)] p-2">
              {personSelect(entry.userId, (userId) => setEntry(index, { userId }))}
              <DayPicker value={entry.days} onChange={(days) => days.length && setEntry(index, { days })} />
              <input type="time" value={entry.start} onChange={(e) => setEntry(index, { start: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Starts" />
              <span>to</span>
              <input type="time" value={entry.end} onChange={(e) => setEntry(index, { end: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Ends" />
              <input
                value={entry.label ?? ''}
                maxLength={60}
                placeholder="Role, such as Front desk"
                onChange={(e) => setEntry(index, { label: e.target.value || undefined })}
                className={cx(FIELD_BASE, 'w-40 py-1 text-xs')}
                aria-label="Label"
              />
              <span className="flex items-center gap-1">
                from
                <input type="date" value={entry.from ?? ''} onChange={(e) => setEntry(index, { from: e.target.value || undefined })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="From" />
                until
                <input type="date" value={entry.until ?? ''} onChange={(e) => setEntry(index, { until: e.target.value || undefined })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Until" />
              </span>
              <IconButton label="Remove these hours" className="ml-auto h-6 w-6" onClick={() => setConfig({ entries: config.entries.filter((_, i) => i !== index) })}>
                <Icon name="x-lg" />
              </IconButton>
            </div>
          ))}
          <Button
            variant="subtle"
            className="py-1 text-xs"
            onClick={() =>
              setConfig({
                entries: [
                  ...config.entries,
                  { id: newId('e', config.entries.map((e) => e.id)), userId: '', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
                ],
              })
            }
          >
            <Icon name="plus-lg" /> Add someone's hours
          </Button>
        </div>
      </div>

      <div className="text-xs text-[var(--color-muted)]">
        <span className="mb-1 block">One-off shifts</span>
        <div className="space-y-1.5">
          {config.oneOffs.map((shift, index) => (
            <div key={shift.id} className="flex flex-wrap items-center gap-2">
              {personSelect(shift.userId, (userId) => setOneOff(index, { userId }))}
              <input type="datetime-local" value={shift.start} onChange={(e) => e.target.value && setOneOff(index, { start: e.target.value.slice(0, 16) })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Starts" />
              <span>to</span>
              <input type="datetime-local" value={shift.end} onChange={(e) => e.target.value && setOneOff(index, { end: e.target.value.slice(0, 16) })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Ends" />
              <input
                value={shift.label ?? ''}
                maxLength={60}
                placeholder="Label"
                onChange={(e) => setOneOff(index, { label: e.target.value || undefined })}
                className={cx(FIELD_BASE, 'w-32 py-1 text-xs')}
                aria-label="Label"
              />
              <IconButton label="Remove this shift" className="h-6 w-6" onClick={() => setConfig({ oneOffs: config.oneOffs.filter((_, i) => i !== index) })}>
                <Icon name="x-lg" />
              </IconButton>
            </div>
          ))}
          <Button
            variant="subtle"
            className="py-1 text-xs"
            onClick={() => {
              const day = todayIn(schedule.timeZone);
              setConfig({
                oneOffs: [...config.oneOffs, { id: newId('o', config.oneOffs.map((s) => s.id)), userId: '', start: `${day}T09:00`, end: `${day}T17:00` }],
              });
            }}
          >
            <Icon name="plus-lg" /> Add a one-off shift
          </Button>
        </div>
      </div>

      {clashes.length > 0 && (
        <ul className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {clashes.slice(0, 5).map((c, i) => (
            <li key={i}>
              <Icon name="exclamation-triangle" /> {name(c.userId)} is on twice at once: {formatRange(c.start, c.end, zone)}
            </li>
          ))}
          {clashes.length > 5 && <li>and {clashes.length - 5} more</li>}
        </ul>
      )}
    </>
  );
}
