import { useState } from 'react';
import type { MyShift, ScheduleRequest } from '@paradocs/shared';
import { useMyShifts, useRequestAction } from '../../api/hooks';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import type { RequestActions } from './ScheduleRequests';
import { formatRange } from './scheduleUi';

/**
 * The buttons on a request for the people who can act on it: taking it when
 * asked, and approving or declining it when it waits for approval.
 */
export function useRequestActions(workspaceId: string, canApprove: (request: ScheduleRequest) => boolean): {
  actions: RequestActions;
  dialogs: React.ReactNode;
} {
  const toast = useToast();
  const act = useRequestAction(workspaceId);
  const [swapping, setSwapping] = useState<ScheduleRequest | null>(null);
  const [declining, setDeclining] = useState<ScheduleRequest | null>(null);

  const run = (request: ScheduleRequest, action: string, body: object | undefined, done: string) =>
    act.mutate(
      { request, action, body },
      {
        onSuccess: () => toast(done),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not do that', 'error'),
      },
    );

  const actions: RequestActions = (request) => (
    <>
      {request.canAccept &&
        (request.kind === 'cover' ? (
          <Button variant="primary" className="py-0.5 text-xs" disabled={act.isPending} onClick={() => run(request, 'accept', undefined, 'The shift is yours')}>
            Take this shift
          </Button>
        ) : (
          <Button variant="primary" className="py-0.5 text-xs" onClick={() => setSwapping(request)}>
            Accept swap…
          </Button>
        ))}
      {request.status === 'accepted' && canApprove(request) && (
        <>
          <Button variant="primary" className="py-0.5 text-xs" disabled={act.isPending} onClick={() => run(request, 'approve', undefined, 'Approved')}>
            Approve
          </Button>
          <Button variant="ghost" className="py-0.5 text-xs" onClick={() => setDeclining(request)}>
            Decline…
          </Button>
        </>
      )}
    </>
  );

  const dialogs = (
    <>
      {swapping && (
        <SwapDialog
          workspaceId={workspaceId}
          request={swapping}
          pending={act.isPending}
          onClose={() => setSwapping(null)}
          onPick={(shift) =>
            act.mutate(
              { request: swapping, action: 'accept', body: { swapStartsAt: shift.start, swapEndsAt: shift.end } },
              {
                onSuccess: () => {
                  setSwapping(null);
                  toast('Swapped');
                },
                onError: (err) => toast(err instanceof Error ? err.message : 'Could not swap', 'error'),
              },
            )
          }
        />
      )}
      {declining && (
        <DeclineDialog
          request={declining}
          onClose={() => setDeclining(null)}
          onDecline={(note, reopen) => {
            run(declining, 'decline', { note, reopen }, reopen ? 'Declined and opened again' : 'Declined');
            setDeclining(null);
          }}
        />
      )}
    </>
  );

  return { actions, dialogs };
}

/** Choosing which of your own shifts on the same schedule to give in return. */
function SwapDialog({
  workspaceId,
  request,
  pending,
  onClose,
  onPick,
}: {
  workspaceId: string;
  request: ScheduleRequest;
  pending: boolean;
  onClose: () => void;
  onPick: (shift: MyShift) => void;
}) {
  const [from] = useState(() => new Date().toISOString());
  const to = new Date(Date.parse(from) + 60 * 86_400_000).toISOString();
  const mine = useMyShifts(workspaceId, from, to);
  const shifts = (mine.data?.shifts ?? []).filter(
    (s) => s.scheduleId === request.scheduleId && s.start > from && !(s.start < request.endsAt && s.end > request.startsAt),
  );
  const [picked, setPicked] = useState<MyShift | null>(null);

  return (
    <Modal
      title={`Swap with ${request.requesterName}`}
      description={`You take ${formatRange(request.startsAt, request.endsAt)}. Choose one of your shifts on ${request.scheduleName} for them to take.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!picked || pending} onClick={() => picked && onPick(picked)}>
            Swap
          </Button>
        </>
      }
    >
      {shifts.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">You have no shifts on this schedule in the next two months to give.</p>
      ) : (
        <ul role="radiogroup" aria-label="Your shift" className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
          {shifts.map((shift) => (
            <li key={shift.start}>
              <label className={cx('flex items-center gap-2 px-3 py-2 text-sm', picked === shift && 'bg-[var(--color-accent-soft)]')}>
                <input type="radio" checked={picked === shift} onChange={() => setPicked(shift)} />
                {formatRange(shift.start, shift.end)}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function DeclineDialog({
  request,
  onClose,
  onDecline,
}: {
  request: ScheduleRequest;
  onClose: () => void;
  onDecline: (note: string, reopen: boolean) => void;
}) {
  const [note, setNote] = useState('');
  const [reopen, setReopen] = useState(true);
  return (
    <Modal
      title="Decline this swap?"
      description={`${request.acceptedByName ?? 'Someone'} offered to take ${request.requesterName}'s ${formatRange(request.startsAt, request.endsAt)}.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" className="text-xs" onClick={() => onDecline(note.trim(), reopen)}>
            Decline
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={reopen} onChange={() => setReopen(true)} /> Open it to others again
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!reopen} onChange={() => setReopen(false)} /> Close the request
        </label>
        <label className="block text-[var(--color-muted)]">
          Note for {request.requesterName} (optional)
          <input autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={cx(FIELD, 'mt-1')} />
        </label>
      </div>
    </Modal>
  );
}
