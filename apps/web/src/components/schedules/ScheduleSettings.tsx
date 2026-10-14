import { useEffect, useState } from 'react';
import type { Schedule } from '@paradocs/shared';
import {
  useDeleteSchedule,
  useMembers,
  useSetOverrideGrants,
  useSetScheduleMembers,
  useTeams,
  useUpdateSchedule,
} from '../../api/hooks';
import { cx } from '../../lib/util';
import { AccessDialog } from '../AccessDialog';
import Icon from '../Icon';
import { ConfirmDialog } from '../Modal';
import { FIELD, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { ColorPicker, MemberPicker, SwitchRow, TimeZoneSelect, type PickedMember } from './scheduleUi';

/**
 * A schedule's settings: its details, who is on it and manages it, who may
 * override its shifts, who can see it, and deleting it.
 */
export default function ScheduleSettings({
  schedule,
  canManageAccess,
  onDeleted,
}: {
  schedule: Schedule;
  canManageAccess: boolean;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const { workspaceId } = schedule;
  const update = useUpdateSchedule(workspaceId, schedule.id);
  const setMembers = useSetScheduleMembers(workspaceId, schedule.id);
  const setGrants = useSetOverrideGrants(workspaceId, schedule.id);
  const remove = useDeleteSchedule(workspaceId);
  const people = useMembers(workspaceId).data ?? [];
  const teams = useTeams(workspaceId).data ?? [];
  const canEdit = schedule.can.edit;

  const [name, setName] = useState(schedule.name);
  const [description, setDescription] = useState(schedule.description);
  const [picked, setPicked] = useState<PickedMember[]>([]);
  const [securing, setSecuring] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [grantPick, setGrantPick] = useState('');

  // What the server holds is what the form starts from, again whenever it changes.
  useEffect(() => {
    setName(schedule.name);
    setDescription(schedule.description);
    setPicked(schedule.members.map((m) => ({ userId: m.userId, manager: m.manager })));
  }, [schedule]);

  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');
  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch, { onError: fail('Could not save') });

  const membersChanged =
    picked.length !== schedule.members.length ||
    picked.some((p) => !schedule.members.some((m) => m.userId === p.userId && m.manager === p.manager));
  const removedCount = schedule.members.filter((m) => !picked.some((p) => p.userId === m.userId)).length;

  const grantOptions = [
    ...teams.filter((t) => !schedule.overrideGrants.some((g) => g.id === t.id)).map((t) => ({ key: `team:${t.id}`, label: `Team: ${t.name}` })),
    ...people
      .filter((p) => !schedule.overrideGrants.some((g) => g.id === p.userId))
      .map((p) => ({ key: `user:${p.userId}`, label: p.name })),
  ];
  const writeGrants = (grants: { kind: 'team' | 'user'; id: string }[]) =>
    setGrants.mutate(
      grants.map((g) => (g.kind === 'team' ? { teamId: g.id } : { userId: g.id })),
      { onError: fail('Could not change who may override') },
    );

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-5">
        <Section title="Details">
          <div className="space-y-3">
            <label className="block text-xs text-[var(--color-muted)]">
              Name
              <input
                value={name}
                disabled={!canEdit}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== schedule.name && save({ name: name.trim() })}
                className={cx(FIELD, 'mt-1')}
              />
            </label>
            <label className="block text-xs text-[var(--color-muted)]">
              Description
              <textarea
                value={description}
                disabled={!canEdit}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== schedule.description && save({ description })}
                className={cx(FIELD, 'mt-1 resize-y')}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-[var(--color-muted)]">
                Time zone
                <TimeZoneSelect value={schedule.timeZone} disabled={!canEdit} onChange={(timeZone) => save({ timeZone })} />
              </label>
              <div className="text-xs text-[var(--color-muted)]">
                Color
                <ColorPicker value={schedule.color} disabled={!canEdit} onChange={(color) => save({ color })} />
              </div>
            </div>
            <SwitchRow
              label="Replacements need approval"
              hint="When on, a manager or someone allowed to approve swaps approves each one before it applies."
              checked={schedule.requiresApproval}
              disabled={!canEdit}
              onChange={(requiresApproval) => save({ requiresApproval })}
            />
          </div>
        </Section>

        <Section
          title="Who is on it"
          hint="Only people on a schedule can ask for cover or take shifts on it. Managers edit it, override its shifts and approve its swaps."
        >
          <MemberPicker members={people} value={picked} onChange={setPicked} disabled={!canEdit} />
          {canEdit && membersChanged && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="primary"
                className="text-xs"
                disabled={setMembers.isPending}
                onClick={() => setMembers.mutate(picked, { onSuccess: () => toast('Saved'), onError: fail('Could not save') })}
              >
                Save
              </Button>
              <Button variant="subtle" className="text-xs" onClick={() => setPicked(schedule.members.map((m) => ({ userId: m.userId, manager: m.manager })))}>
                Undo
              </Button>
              {removedCount > 0 && (
                <span className="text-xs text-[var(--color-muted)]">
                  Taking people off removes them from its rotations from now on and cancels their open requests.
                </span>
              )}
            </div>
          )}
        </Section>

        <Section
          title="Who can override"
          hint="These teams and people can put anyone onto this schedule's shifts directly. Roles with Override shifts can do it on every schedule they see, and managers always can."
        >
          <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {schedule.overrideGrants.map((grant) => (
              <li key={grant.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <Icon name={grant.kind === 'team' ? 'diagram-3' : 'person'} className="text-[var(--color-muted)]" />
                <span className="min-w-0 flex-1 truncate">{grant.name}</span>
                {schedule.can.grantOverride && (
                  <IconButton
                    label={`Remove ${grant.name}`}
                    onClick={() => writeGrants(schedule.overrideGrants.filter((g) => g.id !== grant.id))}
                  >
                    <Icon name="x-lg" />
                  </IconButton>
                )}
              </li>
            ))}
            {schedule.overrideGrants.length === 0 && (
              <li className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody beyond managers and roles that allow it.</li>
            )}
          </ul>
          {schedule.can.grantOverride && grantOptions.length > 0 && (
            <select
              value={grantPick}
              aria-label="Add a team or person who can override"
              onChange={(e) => {
                const [kind, id] = e.target.value.split(':') as ['team' | 'user', string];
                setGrantPick('');
                if (id) writeGrants([...schedule.overrideGrants, { kind, id }]);
              }}
              className={cx(FIELD, 'mt-2')}
            >
              <option value="">Add a team or person…</option>
              {grantOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Section>

        {canManageAccess && (
          <Section title="Who can see it" hint="Limit the schedule to some teams or people, as with a project or channel.">
            <Button variant="subtle" className="text-xs" onClick={() => setSecuring(true)}>
              <Icon name="shield-lock" /> Access…
            </Button>
          </Section>
        )}

        {schedule.can.delete && (
          <Section title="Delete">
            <Button variant="danger" className="text-xs" onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" /> Delete schedule
            </Button>
          </Section>
        )}
      </div>

      {securing && (
        <AccessDialog
          workspaceId={workspaceId}
          target={{ kind: 'schedule', id: schedule.id, name: schedule.name }}
          onClose={() => setSecuring(false)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${schedule.name}?`}
          description="Its rotations, shifts, overrides and requests will be deleted for everyone. This cannot be undone."
          confirmLabel="Delete schedule"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(schedule.id, {
              onSuccess: () => {
                toast(`Deleted ${schedule.name}`);
                onDeleted();
              },
              onError: fail('Could not delete the schedule'),
            });
          }}
        />
      )}
    </div>
  );
}
