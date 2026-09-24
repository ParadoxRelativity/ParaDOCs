import { useState } from 'react';
import type { Team } from '@paradocs/shared';
import { useCreateTeam, useDeleteTeam, useMembers, useTeams, useUpdateTeam } from '../api/hooks';
import { teamChanger, type Can, type MayChangeTeam } from '../lib/permissions';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { ConfirmDialog, Modal } from './Modal';
import { FIELD } from './SettingsParts';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';

type MemberSummary = { userId: string; name: string; email: string; avatarUrl: string | null };

/**
 * Teams: named groups of members, so a folder, document or channel can be
 * locked to a team in one line instead of a list of people. Everyone can see
 * who is on which team. Owners and admins (`canManage`) make, rename and
 * delete them and change anyone's place on them; a role can let someone else
 * change who else is on the teams they are on.
 */
export default function TeamsPanel({ workspaceId, canManage, can }: { workspaceId: string; canManage: boolean; can: Can }) {
  const teams = useTeams(workspaceId);
  const members = useMembers(workspaceId);
  const mayChange = teamChanger(members.data?.find((m) => m.isSelf)?.userId, canManage, can);
  const createTeam = useCreateTeam(workspaceId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  // Read fresh from the list, so the dialog follows each change as it lands.
  const managing = (teams.data ?? []).find((t) => t.id === managingId);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const team = await createTeam.mutateAsync({ name: name.trim() });
      setName('');
      setOpenId(team.id);
      setManagingId(team.id);
      toast(`Team ${team.name} created. Choose who is on it.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the team', 'error');
    }
  }

  return (
    <div className="space-y-4">
      {!canManage && (
        <p className="text-xs text-[var(--color-muted)]">
          {can('teams.members')
            ? 'You can change who else is on the teams you are on. Ask an owner or admin to make a team, or to change your own place on one.'
            : 'Ask an owner or admin to change a team.'}
        </p>
      )}

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
              canEditMembers={members.data?.some((m) => mayChange(team, m.userId)) ?? false}
              open={openId === team.id}
              onToggle={() => setOpenId(openId === team.id ? null : team.id)}
              onManage={() => setManagingId(team.id)}
            />
          ))}
        </ul>
      )}

      {managing && (
        <ManageTeamDialog
          workspaceId={workspaceId}
          team={managing}
          members={members.data ?? []}
          mayChange={mayChange}
          onClose={() => setManagingId(null)}
        />
      )}
    </div>
  );
}

function TeamRow({
  workspaceId,
  team,
  members,
  canManage,
  canEditMembers,
  open,
  onToggle,
  onManage,
}: {
  workspaceId: string;
  team: Team;
  members: MemberSummary[];
  /** Owners and admins, who rename and delete teams. */
  canManage: boolean;
  /** Whether the viewer may change anyone's place on this team. */
  canEditMembers: boolean;
  open: boolean;
  onToggle: () => void;
  onManage: () => void;
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
        {canEditMembers && (
          <Button variant="subtle" className="text-xs" onClick={onManage}>
            {canManage ? 'Manage team' : 'Manage members'}
          </Button>
        )}
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
          {onTeam.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">Nobody yet.</p>
          ) : (
            <MemberLines members={onTeam} />
          )}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete ${team.name}?`}
          description="Members lose any access they had only through this team."
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

/** Everyone in the workspace, found by name or email, each one ticked on or off the team. */
function ManageTeamDialog({
  workspaceId,
  team,
  members,
  mayChange,
  onClose,
}: {
  workspaceId: string;
  team: Team;
  members: MemberSummary[];
  mayChange: MayChangeTeam;
  onClose: () => void;
}) {
  const updateTeam = useUpdateTeam(workspaceId);
  const toast = useToast();
  const [search, setSearch] = useState('');

  const needle = search.trim().toLowerCase();
  const listed = members.filter(
    (m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle),
  );

  function toggleMember(userId: string, on: boolean) {
    const memberIds = on ? [...team.memberIds, userId] : team.memberIds.filter((id) => id !== userId);
    updateTeam.mutate(
      { id: team.id, memberIds },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change who is on the team', 'error') },
    );
  }

  return (
    <Modal
      title={`Manage ${team.name}`}
      description={`${team.memberIds.length} ${team.memberIds.length === 1 ? 'member' : 'members'}`}
      onClose={onClose}
      wide
      footer={
        <Button variant="primary" className="text-xs" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-2">
        <input
          type="search"
          autoFocus
          className={FIELD}
          placeholder="Find a member by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={`Find a member to add to ${team.name}`}
        />
        {needle && listed.length === 0 && (
          <p className="text-xs text-[var(--color-muted)]">Nobody matches “{search.trim()}”.</p>
        )}
        <ul className="scroll-thin max-h-80 space-y-1 overflow-y-auto">
          {listed.map((member) => (
            <li key={member.userId}>
              <label
                className={cx('flex items-center gap-2 text-sm', mayChange(team, member.userId) ? 'cursor-pointer' : 'cursor-default opacity-60')}
                title={mayChange(team, member.userId) ? undefined : 'Only an owner or admin can change this'}
              >
                <input
                  type="checkbox"
                  checked={team.memberIds.includes(member.userId)}
                  disabled={updateTeam.isPending || !mayChange(team, member.userId)}
                  onChange={(e) => toggleMember(member.userId, e.target.checked)}
                />
                <MemberLine member={member} />
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function MemberLines({ members }: { members: MemberSummary[] }) {
  return (
    <ul className="space-y-1">
      {members.map((member) => (
        <li key={member.userId} className="flex items-center gap-2 text-sm">
          <MemberLine member={member} />
        </li>
      ))}
    </ul>
  );
}

function MemberLine({ member }: { member: MemberSummary }) {
  return (
    <>
      <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="sm" />
      <span className="min-w-0 flex-1 truncate">{member.name}</span>
      <span className="truncate text-xs text-[var(--color-muted)]">{member.email}</span>
    </>
  );
}
