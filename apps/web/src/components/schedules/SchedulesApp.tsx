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
import { useRequestActions } from './RequestActions';
import { RequestDialog } from './RequestDialog';
import ScheduleRequests, { MyRequests } from './ScheduleRequests';
import ScheduleOverrides from './ScheduleOverrides';
import ScheduleLayers from './ScheduleLayers';
import ScheduleSettings from './ScheduleSettings';
import ScheduleView, { type ShiftActions } from './ScheduleView';
import { ScheduleDot, ViewTabs } from './scheduleUi';

type View = 'schedule' | 'requests' | 'layers' | 'overrides' | 'settings';

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'schedule', label: 'Schedule', icon: 'calendar-week' },
  { id: 'requests', label: 'Requests', icon: 'person-raised-hand' },
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
  user,
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
  const [requesting, setRequesting] = useState<Shift | null>(null);
  // In a schedule, approving is that schedule's call; across schedules, only taking is offered.
  const requestActions = useRequestActions(workspace.id, () => schedule.data?.can.approve ?? false);
  // Each schedule opens on its first view.
  useEffect(() => setView(VIEWS[0].id), [scheduleId]);

  if (!scheduleId) {
    return (
      <MyShifts workspace={workspace} onOpenSchedule={onOpenSchedule}>
        <MyRequests workspaceId={workspace.id} selfId={user.id} actions={requestActions.actions} />
        {requestActions.dialogs}
      </MyShifts>
    );
  }
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
    render: (shift, close) => {
      // Only your own shifts, before they start, and only on a schedule you are on.
      const mayRequest = data.can.request && shift.userId === user.id && shift.start > new Date().toISOString();
      if (!data.can.override && !mayRequest) return null;
      return (
        <div className="flex flex-wrap gap-1.5">
          {mayRequest && (
            <Button
              variant="subtle"
              className="text-xs"
              onClick={() => {
                close();
                setRequesting(shift);
              }}
            >
              <Icon name="person-raised-hand" /> Request replacement
            </Button>
          )}
          {data.can.override && (
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
          )}
        </div>
      );
    },
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
        {view === 'requests' && (
          <ScheduleRequests scheduleId={data.id} workspaceId={workspace.id} selfId={user.id} actions={requestActions.actions} />
        )}
        {view === 'overrides' && <ScheduleOverrides schedule={data} />}
        {view === 'layers' && <ScheduleLayers schedule={data} />}
        {view === 'settings' && (
          <ScheduleSettings schedule={data} canManageAccess={canManageAccess} onDeleted={onScheduleDeleted} />
        )}
      </div>
      {overriding && <OverrideDialog schedule={data} shift={overriding} onClose={() => setOverriding(null)} />}
      {requestActions.dialogs}
      {requesting && <RequestDialog schedule={data} shift={requesting} selfId={user.id} onClose={() => setRequesting(null)} />}
    </div>
  );
}
