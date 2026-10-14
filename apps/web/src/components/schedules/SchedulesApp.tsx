import { useEffect, useState } from 'react';
import type { Shift, User } from '@paradocs/shared';
import { useSchedule, type WorkspaceSummary } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { ApiError } from '../../api/client';
import { cx } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import { Button, EmptyState, Spinner } from '../ui';
import MyShifts from './MyShifts';
import { OverrideDialog } from './OverrideDialog';
import ScheduleOverrides from './ScheduleOverrides';
import ScheduleLayers from './ScheduleLayers';
import ScheduleSettings from './ScheduleSettings';
import ScheduleView, { type ShiftActions } from './ScheduleView';
import { ScheduleDot, ViewTabs } from './scheduleUi';

type View = 'schedule' | 'layers' | 'overrides' | 'settings';

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'schedule', label: 'Schedule', icon: 'calendar-week' },
  { id: 'layers', label: 'Layers', icon: 'layers' },
  { id: 'overrides', label: 'Overrides', icon: 'arrow-left-right' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

/**
 * The Schedules app: on-call rotations, rotating shifts and work schedules,
 * and the swaps people make on them. With no schedule open it shows your own
 * shifts across all of them.
 */
export default function SchedulesApp({
  workspace,
  scheduleId,
  onOpenSchedule,
  onScheduleDeleted,
}: {
  workspace: WorkspaceSummary;
  user: User;
  scheduleId: string | null;
  onOpenSchedule: (id: string) => void;
  onScheduleDeleted: () => void;
}) {
  const mobile = useIsMobile();
  const schedule = useSchedule(scheduleId ?? undefined);
  const [view, setView] = useState<View>(VIEWS[0].id);
  const [overriding, setOverriding] = useState<Shift | null>(null);
  // Each schedule opens on its first view.
  useEffect(() => setView(VIEWS[0].id), [scheduleId]);

  if (!scheduleId) return <MyShifts workspace={workspace} onOpenSchedule={onOpenSchedule} />;
  if (schedule.isLoading) return <Spinner />;
  if (!schedule.data) {
    const missing = schedule.error instanceof ApiError && schedule.error.status === 404;
    return (
      <EmptyState
        icon="exclamation-triangle"
        title={missing ? 'Schedule not found' : 'Could not open the schedule'}
        hint={missing ? 'It may have been deleted, or you no longer have access.' : (schedule.error as Error | null)?.message}
      />
    );
  }

  const data = schedule.data;
  // What can be done with a shift picked in the views.
  const shiftActions: ShiftActions = {
    render: (shift, close) =>
      data.can.override ? (
        <Button
          variant="subtle"
          className="text-xs"
          onClick={() => {
            close();
            setOverriding(shift);
          }}
        >
          <Icon name="arrow-left-right" /> Override
        </Button>
      ) : null,
  };
  const canManageAccess = workspace.role === 'owner' || workspace.role === 'admin';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
        <ScheduleDot color={data.color} />
        <h1 className={cx('min-w-0 truncate text-base font-semibold', mobile && 'flex-1 basis-0')}>{data.name}</h1>
        <span className="text-xs text-[var(--color-muted)]">{data.timeZone.replace(/_/g, ' ')}</span>
        {!mobile && <ViewTabs views={VIEWS} view={view} onChange={setView} />}
        {mobile && <ViewTabs views={VIEWS} view={view} onChange={setView} mobile />}
      </div>
      <div className="min-h-0 flex-1">
        {view === 'schedule' && <ScheduleView schedule={data} actions={shiftActions} />}
        {view === 'overrides' && <ScheduleOverrides schedule={data} />}
        {view === 'layers' && <ScheduleLayers schedule={data} />}
        {view === 'settings' && (
          <ScheduleSettings schedule={data} canManageAccess={canManageAccess} onDeleted={onScheduleDeleted} />
        )}
      </div>
      {overriding && <OverrideDialog schedule={data} shift={overriding} onClose={() => setOverriding(null)} />}
    </div>
  );
}
