import { useState } from 'react';
import type { Schedule, Shift } from '@paradocs/shared';
import { useCreateRequest, useScheduleShifts } from '../../api/hooks';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { formatRange, fromLocalInput, toLocalInput } from './scheduleUi';

/**
 * Asking the others on a schedule to take one of your shifts, or part of it,
 * or to swap it for one of theirs. Only people on the same schedule can be
 * asked. Anyone already on during that time is shown with a warning rather
 * than left out: they may still be able to help.
 */
export function RequestDialog({ schedule, shift, selfId, onClose }: { schedule: Schedule; shift: Shift; selfId: string; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRequest(schedule.workspaceId, schedule.id);
  const [kind, setKind] = useState<'cover' | 'swap'>('cover');
  const [whole, setWhole] = useState(true);
  const [start, setStart] = useState(toLocalInput(shift.start));
  const [end, setEnd] = useState(toLocalInput(shift.end));
  const [note, setNote] = useState('');
  const [everyone, setEveryone] = useState(true);
  const [asked, setAsked] = useState<string[]>([]);

  const startsAt = whole ? shift.start : start ? fromLocalInput(start) : '';
  const endsAt = whole ? shift.end : end ? fromLocalInput(end) : '';
  const outside = startsAt < shift.start || endsAt > shift.end;
  const valid = Boolean(startsAt && endsAt && endsAt > startsAt && !outside && (everyone || asked.length));

  // Who else is on during the window, to warn about.
  const during = useScheduleShifts(schedule.id, startsAt || shift.start, endsAt || shift.end);
  const busy = new Set(
    (during.data?.shifts ?? [])
      .filter((s) => s.userId !== selfId && s.start < (endsAt || shift.end) && s.end > (startsAt || shift.start))
      .map((s) => s.userId),
  );
  const others = schedule.members.filter((m) => m.userId !== selfId);

  async function send() {
    if (!valid) return;
    try {
      await create.mutateAsync({ kind, startsAt, endsAt, note: note.trim() || undefined, askUserIds: everyone ? undefined : asked });
      toast(everyone ? 'Asked everyone on the schedule' : `Asked ${asked.length === 1 ? 'one person' : `${asked.length} people`}`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the request', 'error');
    }
  }

  return (
    <Modal
      title="Request a replacement"
      description={formatRange(shift.start, shift.end)}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!valid || create.isPending} onClick={() => void send()}>
            Send request
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
          {(
            [
              { id: 'cover', label: 'Cover', hint: 'Someone takes my time.' },
              { id: 'swap', label: 'Swap', hint: 'I take one of their shifts in return.' },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={kind === option.id}
              onClick={() => setKind(option.id)}
              className={cx(
                'rounded-lg border px-3 py-2 text-left',
                kind === option.id ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
              )}
            >
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-[var(--color-muted)]">{option.hint}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={whole} onChange={() => setWhole(true)} /> The whole shift
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!whole} onChange={() => setWhole(false)} /> Part of it
          </label>
        </div>
        {!whole && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-[var(--color-muted)]">
              From
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={cx(FIELD, 'mt-1')} />
            </label>
            <label className="block text-xs text-[var(--color-muted)]">
              Until
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={cx(FIELD, 'mt-1')} />
            </label>
          </div>
        )}
        {outside && <p className="text-xs text-red-500">Keep it within your shift.</p>}

        <div className="text-xs">
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> Ask everyone on {schedule.name}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={!everyone} onChange={() => setEveryone(false)} /> Ask specific people
            </label>
          </div>
          <ul className="mt-2 divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {others.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 px-2 py-1.5">
                {!everyone && (
                  <input
                    type="checkbox"
                    aria-label={`Ask ${m.name}`}
                    checked={asked.includes(m.userId)}
                    onChange={() => setAsked(asked.includes(m.userId) ? asked.filter((id) => id !== m.userId) : [...asked, m.userId])}
                  />
                )}
                <Avatar name={m.name} url={m.avatarUrl} seed={m.userId} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                {busy.has(m.userId) && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">
                    <Icon name="exclamation-triangle" /> On during this time
                  </span>
                )}
              </li>
            ))}
            {others.length === 0 && <li className="px-3 py-2 text-[var(--color-muted)]">Nobody else is on this schedule yet.</li>}
          </ul>
        </div>

        <label className="block text-xs text-[var(--color-muted)]">
          Note (optional)
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Family wedding" className={cx(FIELD, 'mt-1')} />
        </label>
      </div>
    </Modal>
  );
}
