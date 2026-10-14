import { useState } from 'react';
import type { Schedule } from '@paradocs/shared';
import { useDeleteOverride, useScheduleOverrides } from '../../api/hooks';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { Button, EmptyState, IconButton, Spinner } from '../ui';
import { OverrideDialog } from './OverrideDialog';
import { formatRange, formatWhen } from './scheduleUi';

/** A schedule's overrides from today on, each of which can be taken back. */
export default function ScheduleOverrides({ schedule }: { schedule: Schedule }) {
  const toast = useToast();
  const [from] = useState(() => new Date(Date.now() - 86_400_000).toISOString());
  const to = new Date(Date.parse(from) + 90 * 86_400_000).toISOString();
  const overrides = useScheduleOverrides(schedule.id, from, to);
  const remove = useDeleteOverride(schedule.workspaceId, schedule.id);
  const [adding, setAdding] = useState(false);
  const list = (overrides.data ?? []).filter((o) => o.endsAt > new Date().toISOString());

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-5">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
            Overrides put someone else on a shift, or part of one. Pick a shift in the Schedule tab to override it, or add cover here.
          </p>
          {schedule.can.override && (
            <Button variant="primary" className="shrink-0 text-xs" onClick={() => setAdding(true)}>
              <Icon name="plus-lg" /> Add cover
            </Button>
          )}
        </div>
        {!overrides.data ? (
          <Spinner />
        ) : list.length === 0 ? (
          <EmptyState icon="arrow-left-right" title="No overrides coming up" />
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {list.map((o) => (
              <li key={o.id} className="flex items-start gap-3 px-3 py-2">
                <Icon name={o.source === 'request' ? 'people' : 'arrow-left-right'} className="mt-0.5 text-[var(--color-muted)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{o.userName}</span>
                    {o.replacedUserName ? ` covers for ${o.replacedUserName}` : ' adds cover'}
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">{formatRange(o.startsAt, o.endsAt)}</p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    {o.source === 'request' ? 'Swapped through a request' : `Set by ${o.createdByName ?? 'someone'}`} · {formatWhen(o.createdAt)}
                    {o.note && ` · “${o.note}”`}
                  </p>
                </div>
                {schedule.can.override && (
                  <IconButton
                    label="Remove override"
                    onClick={() =>
                      remove.mutate(o.id, {
                        onSuccess: () => toast('Override removed'),
                        onError: (err) => toast(err instanceof Error ? err.message : 'Could not remove it', 'error'),
                      })
                    }
                  >
                    <Icon name="arrow-counterclockwise" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {adding && <OverrideDialog schedule={schedule} shift={null} onClose={() => setAdding(false)} />}
    </div>
  );
}
