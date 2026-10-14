import type { User } from '@paradocs/shared';
import type { WorkspaceSummary } from '../../api/hooks';
import { EmptyState } from '../ui';

/**
 * The Schedules app: on-call rotations, rotating shifts and work schedules,
 * and the swaps people make on them.
 */
export default function SchedulesApp({
  scheduleId,
}: {
  workspace: WorkspaceSummary;
  user: User;
  scheduleId: string | null;
}) {
  if (!scheduleId) {
    return <EmptyState icon="calendar-week" title="Schedules" hint="Schedules you are on will show up here." />;
  }
  return <EmptyState icon="calendar-week" title="Schedule" />;
}
