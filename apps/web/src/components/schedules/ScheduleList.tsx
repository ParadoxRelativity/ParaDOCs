import { useState } from 'react';
import { useSchedules } from '../../api/hooks';
import type { Can } from '../../lib/permissions';
import { cx } from '../../lib/util';
import { LockMark } from '../AccessDialog';
import Icon from '../Icon';
import { IconButton } from '../ui';
import { NewScheduleDialog } from './NewScheduleDialog';
import { ScheduleDot } from './scheduleUi';

/** The Schedules app's side of the sidebar: your own shifts, then the schedules you can see. */
export function ScheduleList({
  workspaceId,
  activeScheduleId,
  can,
  onOpenMine,
  onSelect,
}: {
  workspaceId: string;
  /** Null while My shifts is showing. */
  activeScheduleId: string | null;
  can: Can;
  onOpenMine: () => void;
  onSelect: (scheduleId: string) => void;
}) {
  const schedules = useSchedules(workspaceId);
  const [creating, setCreating] = useState(false);
  const list = schedules.data ?? [];
  const row = (active: boolean) =>
    cx(
      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
      active ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'hover:bg-[var(--color-line)]/50',
    );

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
      <button onClick={onOpenMine} className={row(activeScheduleId === null)}>
        <span className="w-4 text-center text-xs">
          <Icon name="person-check" />
        </span>
        <span className="flex-1 text-left">My shifts</span>
      </button>

      <div className="mt-3">
        <div className="mb-0.5 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Schedules</span>
          {can('schedules.create') && (
            <IconButton label="New schedule" className="h-6 w-6" onClick={() => setCreating(true)}>
              <Icon name="plus-lg" />
            </IconButton>
          )}
        </div>
        {list.map((schedule) => (
          <button key={schedule.id} onClick={() => onSelect(schedule.id)} className={row(schedule.id === activeScheduleId)}>
            <span className="grid w-4 place-items-center">
              <ScheduleDot color={schedule.color} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{schedule.name}</span>
            <LockMark access={schedule.access} />
            {schedule.isMember && (
              <Icon name="person-fill" className="text-[10px] text-[var(--color-muted)]" />
            )}
          </button>
        ))}
        {schedules.isSuccess && list.length === 0 && (
          <p className="px-2 py-1 text-xs text-[var(--color-muted)]">
            {can('schedules.create') ? 'No schedules yet. Start one with +.' : 'No schedules you can see yet.'}
          </p>
        )}
      </div>

      {creating && (
        <NewScheduleDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onCreated={(schedule) => {
            setCreating(false);
            onSelect(schedule.id);
          }}
        />
      )}
    </div>
  );
}
