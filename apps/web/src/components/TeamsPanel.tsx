import { useState } from 'react';
import type { Role, Team } from '@paradocs/shared';
import { useCreateTeam, useDeleteTeam, useMembers, useTeams, useUpdateTeam } from '../api/hooks';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { ConfirmDialog } from './Modal';
import { FIELD } from './SettingsParts';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';

/**
 * Teams: named groups of members, so a folder, document or channel can be
 * locked to a team in one line instead of a list of people. Everyone can see
 * who is on which team; owners and admins make and change them.
 */
export default function TeamsPanel({ workspaceId, myRole }: { workspaceId: string; myRole: Role }) {
  const canManage = myRole === 'owner' || myRole === 'admin';
  const teams = useTeams(workspaceId);
  const members = useMembers(workspaceId);
  const createTeam = useCreateTeam(workspaceId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const team = await createTeam.mutateAsync({ name: name.trim() });
      setName('');
      setOpenId(team.id);
      toast(`Team ${team.name} created. Add its members below.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the team', 'error');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-muted)]">
        Teams let you lock a folder, document or channel to a group of people at once. Everything is open to the whole
        workspace until someone locks it.
        {!canManage && ' Ask an owner or admin to change a team.'}
      </p>

      {canManage && (
        <form onSubmit={(e) => void create(e)} className="flex gap-1.5">
          <input
            className={cx(FIELD, 'min-w-0 flex-1')}
            placeholder="New team name, such as Design"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="primary" className="shrink-0 text-xs" type="submit" disabled={!name.trim() || createTeam.isPending}>
            Create team
          </Button>
        </form>
      )}

      {teams.isLoading || members.isLoading ? (
        <Spinner />
      ) : (teams.data ?? []).length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-line)] px-3 py-6 text-center text-xs text-[var(--color-muted)]">
          No teams yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
          {(teams.data ?? []).map((team) => (
            <TeamRow
              key={team.id}
              workspaceId={workspaceId}
              team={team}
              members={members.data ?? []}
              canManage={canManage}
              open={openId === team.id}
              onToggle={() => setOpenId(openId === team.id ? null : team.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamRow({
  workspaceId,
  team,
  members,
  canManage,
  open,
  onToggle,
}: {
  workspaceId: string;
  team: Team;
  members: { userId: string; name: string; email: string; avatarUrl: string | null }[];
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const updateTeam = useUpdateTeam(workspaceId);
  const deleteTeam = useDeleteTeam(workspaceId);
  const toast = useToast();
  const [name, setName] = useState(team.name);
  const [confirming, setConfirming] = useState(false);

  const onTeam = members.filter((m) => team.memberIds.includes(m.userId));
  const failed = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');

  function rename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === team.name) {
      setName(team.name);
      return;
    }
    updateTeam.mutate({ id: team.id, name: trimmed }, { onError: failed('Could not rename the team') });
  }

  function toggleMember(userId: string, on: boolean) {
    const memberIds = on ? [...team.memberIds, userId] : team.memberIds.filter((id) => id !== userId);
    updateTeam.mutate({ id: team.id, memberIds }, { onError: failed('Could not change who is on the team') });
  }

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon
            name="chevron-right"
            className={cx('text-[10px] text-[var(--color-muted)] transition-transform', open && 'rotate-90')}
          />
          <span className="truncate text-sm font-medium">{team.name}</span>
          <span className="shrink-0 text-xs text-[var(--color-muted)]">
            {team.memberIds.length} {team.memberIds.length === 1 ? 'member' : 'members'}
          </span>
        </button>
        {canManage && (
          <Button variant="danger" className="text-xs" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2 pl-5">
          {canManage && (
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Name</span>
              <input
                className={FIELD}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </label>
          )}
          <ul className="space-y-1">
            {(canManage ? members : onTeam).map((member) => {
              const checked = team.memberIds.includes(member.userId);
              return (
                <li key={member.userId}>
                  <label className={cx('flex items-center gap-2 text-sm', canManage && 'cursor-pointer')}>
                    {canManage && (
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={updateTeam.isPending}
                        onChange={(e) => toggleMember(member.userId, e.target.checked)}
                      />
                    )}
                    <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                    <span className="truncate text-xs text-[var(--color-muted)]">{member.email}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {!canManage && onTeam.length === 0 && <p className="text-xs text-[var(--color-muted)]">Nobody yet.</p>}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete ${team.name}?`}
          description="Its line comes off every allow and deny list that names it. Where a list let the team in, its members lose that access unless they are listed some other way."
          confirmLabel="Delete team"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            deleteTeam.mutate(team.id, {
              onSuccess: () => toast(`Deleted ${team.name}`),
              onError: failed('Could not delete the team'),
            });
          }}
        />
      )}
    </li>
  );
}
