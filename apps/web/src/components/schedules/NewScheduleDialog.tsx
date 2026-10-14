import { useState } from 'react';
import { SCHEDULE_COLORS, type Schedule } from '@paradocs/shared';
import { useCreateSchedule, useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { ColorPicker, MemberPicker, SwitchRow, TimeZoneSelect, localTimeZone, type PickedMember } from './scheduleUi';

/** Starting a schedule: its name, zone, color, who is on it and whether swaps need approval. */
export function NewScheduleDialog({
  workspaceId,
  onCreated,
  onClose,
}: {
  workspaceId: string;
  onCreated: (schedule: Schedule) => void;
  onClose: () => void;
}) {
  const create = useCreateSchedule(workspaceId);
  const members = useMembers(workspaceId).data ?? [];
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [timeZone, setTimeZone] = useState(localTimeZone);
  const [color, setColor] = useState<string>(SCHEDULE_COLORS[0]);
  const [picked, setPicked] = useState<PickedMember[]>([]);
  // Off unless asked for: a swap two people agree on applies straight away.
  const [requiresApproval, setRequiresApproval] = useState(false);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    try {
      onCreated(
        await create.mutateAsync({ name: name.trim(), description, timeZone, color, requiresApproval, members: picked }),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the schedule', 'error');
    }
  }

  return (
    <Modal
      title="New schedule"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!name.trim() || create.isPending} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <label className="block text-xs text-[var(--color-muted)]">
          Name
          <input
            autoFocus
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="Platform on-call"
            className={cx(FIELD, 'mt-1')}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-[var(--color-muted)]">
            Time zone
            <TimeZoneSelect value={timeZone} onChange={setTimeZone} />
          </label>
          <div className="text-xs text-[var(--color-muted)]">
            Color
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </div>
        <label className="block text-xs text-[var(--color-muted)]">
          Description
          <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} className={cx(FIELD, 'mt-1 resize-y')} />
        </label>
        <div className="text-xs text-[var(--color-muted)]">
          <span className="mb-1 block">Who is on it</span>
          <MemberPicker members={members} value={picked} onChange={setPicked} />
        </div>
        <SwitchRow
          label="Replacements need approval"
          hint="When on, a manager approves each swap before it applies. Off, a swap applies as soon as someone takes it."
          checked={requiresApproval}
          onChange={setRequiresApproval}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
