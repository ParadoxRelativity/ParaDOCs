import { useState, type ReactNode } from 'react';
import type { ScheduleRequest, ScheduleRequestStatus } from '@paradocs/shared';
import { useMyRequests, useRequestAction, useScheduleRequests, useSchedules } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { Button, EmptyState, Spinner } from '../ui';
import { ScheduleDot, formatRange, formatWhen } from './scheduleUi';

const STATUS: Record<ScheduleRequestStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  accepted: { label: 'Waiting for approval', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  approved: { label: 'Done', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  declined: { label: 'Declined', tone: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  cancelled: { label: 'Cancelled', tone: 'bg-[var(--color-surface)] text-[var(--color-muted)]' },
  expired: { label: 'Expired', tone: 'bg-[var(--color-surface)] text-[var(--color-muted)]' },
};

/** What can be done with a request, beyond cancelling one's own. Taking and approving add theirs. */
export type RequestActions = (request: ScheduleRequest) => ReactNode;

/** One request: who asked, for what, who was asked, and where it stands. */
export function RequestCard({
  request,
  selfId,
  workspaceId,
  showSchedule,
  actions,
}: {
  request: ScheduleRequest;
  selfId: string;
  workspaceId: string;
  showSchedule?: { color: string } | null;
  actions?: RequestActions;
}) {
  const toast = useToast();
  const act = useRequestAction(workspaceId);
  const mine = request.requesterId === selfId;
  const live = request.status === 'open' || request.status === 'accepted';
  const asked = request.askEveryone ? 'everyone on the schedule' : request.candidates.map((c) => c.name).join(', ');

  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon name={request.kind === 'swap' ? 'arrow-left-right' : 'person-raised-hand'} className="mt-0.5 text-[var(--color-muted)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {showSchedule && <ScheduleDot color={showSchedule.color} className="mr-1" />}
            <span className="font-medium">{mine ? 'You' : request.requesterName}</span>
            {request.kind === 'swap' ? ' offered a swap' : ' asked for cover'}
            {showSchedule && <span className="text-[var(--color-muted)]"> on {request.scheduleName}</span>}
          </p>
          <p className="text-xs text-[var(--color-muted)]">{formatRange(request.startsAt, request.endsAt)}</p>
          {request.note && <p className="mt-0.5 text-xs">“{request.note}”</p>}
          <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
            Asked {asked} · {formatWhen(request.createdAt)}
          </p>
          {request.acceptedByName && (
            <p className="mt-0.5 text-xs">
              {request.acceptedBy === selfId ? 'You' : request.acceptedByName} took it
              {request.swapStartsAt && request.swapEndsAt && `, giving ${formatRange(request.swapStartsAt, request.swapEndsAt)} in return`}
            </p>
          )}
          {request.decidedByName && (
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {request.status === 'declined' ? 'Declined' : 'Approved'} by {request.decidedByName}
              {request.decisionNote && `: “${request.decisionNote}”`}
            </p>
          )}
        </div>
        <span className={cx('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS[request.status].tone)}>
          {STATUS[request.status].label}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6 empty:hidden">
        {actions?.(request)}
        {mine && live && (
          <Button
            variant="ghost"
            className="py-0.5 text-xs"
            disabled={act.isPending}
            onClick={() =>
              act.mutate(
                { request, action: 'cancel' },
                {
                  onSuccess: () => toast('Request cancelled'),
                  onError: (err) => toast(err instanceof Error ? err.message : 'Could not cancel it', 'error'),
                },
              )
            }
          >
            Cancel request
          </Button>
        )}
      </div>
    </li>
  );
}

/** A schedule's requests: open and waiting ones first, and the recent past on request. */
export default function ScheduleRequests({
  scheduleId,
  workspaceId,
  selfId,
  actions,
}: {
  scheduleId: string;
  workspaceId: string;
  selfId: string;
  actions?: RequestActions;
}) {
  const [all, setAll] = useState(false);
  const requests = useScheduleRequests(scheduleId, all);
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-5">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
            To ask for cover, pick one of your shifts in the Schedule tab. Only people on this schedule can be asked, or take a shift.
          </p>
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show past
          </label>
        </div>
        {!requests.data ? (
          <Spinner />
        ) : requests.data.length === 0 ? (
          <EmptyState icon="person-raised-hand" title="No open requests" />
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {requests.data.map((request) => (
              <RequestCard key={request.id} request={request} selfId={selfId} workspaceId={workspaceId} actions={actions} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Requests you made or were asked on, across every schedule, for the top of My shifts. */
export function MyRequests({ workspaceId, selfId, actions }: { workspaceId: string; selfId: string; actions?: RequestActions }) {
  const requests = useMyRequests(workspaceId);
  const schedules = useSchedules(workspaceId).data ?? [];
  const list = requests.data ?? [];
  if (list.length === 0) return null;
  return (
    <section className="border-b border-[var(--color-line)] px-4 py-3">
      <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Requests</h2>
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {list.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            selfId={selfId}
            workspaceId={workspaceId}
            showSchedule={{ color: schedules.find((s) => s.id === request.scheduleId)?.color ?? '#64748b' }}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );
}
