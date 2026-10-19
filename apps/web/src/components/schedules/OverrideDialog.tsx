import { useState } from 'react';
import type { Schedule, Shift } from '@paradocs/shared';
import { useCreateOverride, useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { formatRange, fromLocalInput, toLocalInput } from './scheduleUi';

/**
 * Putting someone onto a shift, or part of one, directly. Anyone in the
 * workspace can be chosen — people on the schedule are listed first — and the
 * server turns away anyone who cannot see it.
 */
export function OverrideDialog({
  schedule,
  shift,
  onClose,
}: {
  schedule: Schedule;
  /** The shift being covered; null to add cover where nobody may be on. */
  shift: Shift | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateOverride(schedule.workspaceId, schedule.id);
  const people = useMembers(schedule.workspaceId).data ?? [];
  const onSchedule = new Set(schedule.members.map((m) => m.userId));
  const choices = people
    .filter((p) => p.userId !== shift?.userId)
    .sort((a, b) => Number(onSchedule.has(b.userId)) - Number(onSchedule.has(a.userId)) || a.name.localeCompare(b.name));
  const [userId, setUserId] = useState('');
  const [whole, setWhole] = useState(true);
  const defaultStart = shift?.start ?? new Date().toISOString();
  const defaultEnd = shift?.end ?? new Date(Date.now() + 8 * 3_600_000).toISOString();
  const [start, setStart] = useState(toLocalInput(defaultStart));
  const [end, setEnd] = useState(toLocalInput(defaultEnd));
  const [note, setNote] = useState('');
  const name = (id: string) => people.find((p) => p.userId === id)?.name ?? 'Former member';

  const startsAt = whole && shift ? shift.start : start ? fromLocalInput(start) : '';
  const endsAt = whole && shift ? shift.end : end ? fromLocalInput(end) : '';
  const outside = shift && (startsAt < shift.start || endsAt > shift.end);
  const valid = Boolean(userId && startsAt && endsAt && endsAt > startsAt && !outside);

  async function save() {
    if (!valid) return;
    try {
      await create.mutateAsync({ userId, replacedUserId: shift?.userId ?? null, startsAt, endsAt, note: note.trim() || undefined });
      toast(shift ? `${name(userId)} now covers for ${name(shift.userId)}` : `${name(userId)} added`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not override the shift', 'error');
    }
  }

  return (
    <Modal
      title={shift ? `Override ${name(shift.userId)}'s shift` : 'Add cover'}
      description={shift ? formatRange(shift.start, shift.end) : 'Put someone on for a stretch of time, alongside whoever is on.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!valid || create.isPending} onClick={() => void save()}>
            Override
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-[var(--color-muted)]">
          Who covers
          <select autoFocus value={userId} onChange={(e) => setUserId(e.target.value)} className={cx(FIELD, 'mt-1')}>
            <option value="">Choose someone…</option>
            <optgroup label="On this schedule">
              {choices.filter((p) => onSchedule.has(p.userId)).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Everyone else in the workspace">
              {choices.filter((p) => !onSchedule.has(p.userId)).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {shift && (
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={whole} onChange={() => setWhole(true)} /> The whole shift
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={!whole} onChange={() => setWhole(false)} /> Part of it
            </label>
          </div>
        )}
        {(!whole || !shift) && (
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
        {outside && <p className="text-xs text-red-500">Keep it within the shift.</p>}
        <label className="block text-xs text-[var(--color-muted)]">
          Note (optional)
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Sick day" className={cx(FIELD, 'mt-1')} />
        </label>
      </div>
    </Modal>
  );
}
