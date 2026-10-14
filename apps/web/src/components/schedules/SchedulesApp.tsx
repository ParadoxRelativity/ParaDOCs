import { useEffect, useState } from 'react';
import type { User } from '@paradocs/shared';
import { useSchedule, type WorkspaceSummary } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { ApiError } from '../../api/client';
import { cx } from '../../lib/util';
import type { IconName } from '../Icon';
import { EmptyState, Spinner } from '../ui';
import ScheduleLayers from './ScheduleLayers';
import ScheduleSettings from './ScheduleSettings';
import { ScheduleDot, ViewTabs } from './scheduleUi';

type View = 'layers' | 'settings';

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'layers', label: 'Layers', icon: 'layers' },
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
  // Each schedule opens on its first view.
  useEffect(() => setView(VIEWS[0].id), [scheduleId]);

  if (!scheduleId) {
    return <EmptyState icon="calendar-week" title="My shifts" hint="Your shifts across every schedule will show up here." />;
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
        {view === 'layers' && <ScheduleLayers schedule={data} />}
        {view === 'settings' && (
          <ScheduleSettings schedule={data} canManageAccess={canManageAccess} onDeleted={onScheduleDeleted} />
        )}
      </div>
    </div>
  );
}
