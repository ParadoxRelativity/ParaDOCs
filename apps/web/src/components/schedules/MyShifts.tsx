import { useState } from 'react';
import type { MyShift } from '@paradocs/shared';
import { useMembers, useMyShifts, useScheduleSettings, useUpdateScheduleSettings, type WorkspaceSummary } from '../../api/hooks';
import { FIELD_BASE } from '../SettingsParts';
import { useToast } from '../Toast';
import Icon from '../Icon';
import { Button, EmptyState, Spinner } from '../ui';
import { ShiftList } from './ScheduleView';

const WEEKS = 4;

/** Your shifts across every schedule, from today on. Requests involving you join them in PARA-81. */
export default function MyShifts({
  workspace,
  onOpenSchedule,
  children,
}: {
  workspace: WorkspaceSummary;
  onOpenSchedule: (id: string) => void;
  /** More about you, shown above the shifts: your requests. */
  children?: React.ReactNode;
}) {
  const [weeks, setWeeks] = useState(WEEKS);
  // From the start of today, so a shift running now still shows.
  const [from] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  });
  const to = new Date(Date.parse(from) + weeks * 7 * 86_400_000).toISOString();
  const mine = useMyShifts(workspace.id, from, to);
  const people = useMembers(workspace.id).data ?? [];
  const name = (id: string | null | undefined) => (id ? (people.find((p) => p.userId === id)?.name ?? 'Former member') : '');
  const shifts = (mine.data?.shifts ?? []).filter((s) => s.end > new Date().toISOString());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
        <Icon name="person-check" />
        <h1 className="flex-1 text-base font-semibold">My shifts</h1>
        <ReminderSetting />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {children}
        {!mine.data ? (
          <Spinner />
        ) : shifts.length === 0 ? (
          <EmptyState icon="calendar-check" title="No shifts coming up" hint={`Nothing for you in the next ${weeks} weeks.`} />
        ) : (
          <ShiftList
            shifts={shifts}
            name={name}
            person={(id) => people.find((p) => p.userId === id)}
            onPick={(shift) => onOpenSchedule((shift as MyShift).scheduleId)}
            scheduleOf={(shift) => {
              const mineShift = shift as MyShift;
              return { name: mineShift.scheduleName, color: mineShift.color };
            }}
          />
        )}
        {mine.data && weeks < 13 && (
          <div className="p-4 text-center">
            <Button variant="subtle" className="text-xs" onClick={() => setWeeks(weeks + WEEKS)}>
              Show more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const REMINDER_CHOICES = [
  { minutes: 0, label: 'Never' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 1440, label: '1 day before' },
];

/** How long before each shift you are reminded, in the app. */
function ReminderSetting() {
  const toast = useToast();
  const settings = useScheduleSettings();
  const update = useUpdateScheduleSettings();
  const value = settings.data?.reminderMinutes ?? 60;
  const choices = REMINDER_CHOICES.some((c) => c.minutes === value) ? REMINDER_CHOICES : [...REMINDER_CHOICES, { minutes: value, label: `${value} minutes before` }];
  return (
    <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
      <Icon name="alarm" />
      <span className="hidden sm:inline">Remind me</span>
      <select
        value={value}
        disabled={!settings.data || update.isPending}
        onChange={(e) =>
          update.mutate(
            { reminderMinutes: Number(e.target.value) },
            { onError: (err) => toast(err instanceof Error ? err.message : 'Could not save', 'error') },
          )
        }
        className={FIELD_BASE + ' py-1 text-xs'}
        aria-label="Remind me before my shifts"
      >
        {choices.map((c) => (
          <option key={c.minutes} value={c.minutes}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
