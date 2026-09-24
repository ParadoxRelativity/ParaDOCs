import { useState } from 'react';
import type { Role, Team, WorkspaceMember, WorkspaceRole } from '@paradocs/shared';
import {
  useCreateInvite,
  useInvites,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
  useSetMemberTeams,
  useTeams,
  useUpdateMember,
  useWorkspaceRoles,
} from '../api/hooks';
import { teamChanger, type Can, type MayChangeTeam } from '../lib/permissions';
import { cx, formatRelative } from '../lib/util';
import { shareOrigin } from '../lib/server';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';
import Avatar from './Avatar';
import Icon from './Icon';
import { Popover } from './Popover';

interface Props {
  workspaceId: string;
  myRole: Role;
  /** What the viewer's role lets them do: invite people, or put them on teams. */
  can: Can;
}

/**
 * The roles someone may give out: any but Owner for an admin, and Owner too
 * for an owner. Anyone else who may invite people may give out only a role
 * that allows nothing theirs does not, which the server holds them to.
 */
export function grantableRoles(roles: WorkspaceRole[], myRole: Role, can: Can): WorkspaceRole[] {
  if (myRole === 'owner') return roles;
  if (myRole === 'admin') return roles.filter((r) => r.system !== 'owner');
  return roles.filter((r) => !r.system && r.permissions.every(can));
}

/** Member list, team designations and invite management. Rendered in the Access app. */
export default function MembersPanel({ workspaceId, myRole, can }: Props) {
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canInvite = can('members.invite');
  const members = useMembers(workspaceId);
  const teams = useTeams(workspaceId);
  const roles = useWorkspaceRoles(workspaceId);
  const mayChangeTeam = teamChanger(members.data?.find((m) => m.isSelf)?.userId, canManage, can);
  const invites = useInvites(workspaceId, canInvite);
  const updateMember = useUpdateMember(workspaceId);
  const removeMember = useRemoveMember(workspaceId);
  const createInvite = useCreateInvite(workspaceId);
  const revokeInvite = useRevokeInvite(workspaceId);
  const toast = useToast();

  const [email, setEmail] = useState('');
  // Unset until chosen, which means the workspace's default role.
  const [inviteRoleId, setInviteRoleId] = useState('');
  const [search, setSearch] = useState('');

  const roleList = roles.data ?? [];
  const roleById = new Map(roleList.map((r) => [r.id, r]));
  const invitable = grantableRoles(roleList, myRole, can).filter((r) => r.system !== 'owner');
  const defaultRole = roleList.find((r) => r.isDefault);
  const chosenInviteRole =
    invitable.find((r) => r.id === inviteRoleId) ??
    (defaultRole && invitable.includes(defaultRole) ? defaultRole : invitable[invitable.length - 1]);

  const control =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';

  const teamList = teams.data ?? [];
  const everyone = members.data ?? [];
  // A search matches a name, an email, a role or the name of a team someone is on.
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? everyone.filter((member) =>
        [
          member.name,
          member.email,
          member.workspaceRole.name,
          ...teamList.filter((team) => team.memberIds.includes(member.userId)).map((team) => team.name),
        ].some((value) => value.toLowerCase().includes(needle)),
      )
    : everyone;

  function inviteLink(token: string) {
    return `${shareOrigin()}/invite/${token}`;
  }

  async function copy(token: string) {
    const link = inviteLink(token);
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      // Clipboard needs a secure context; show the link so it can be copied by hand.
      toast(link, 'error');
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const invite = await createInvite.mutateAsync({ email: email.trim() || null, roleId: chosenInviteRole?.id });
      setEmail('');
      await copy(invite.token);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create invite', 'error');
    }
  }

  function changeRole(userId: string, roleId: string) {
    updateMember.mutate(
      { userId, roleId },
      {
        onSuccess: () => toast('Role updated'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not update role', 'error'),
      },
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-muted)]">
        {canManage
          ? 'Invite people by email, or create a link anyone can use to join. Set each person’s role and the teams they are on. What each role allows is under Roles.'
          : canInvite
            ? 'Invite people by email, or create a link anyone can use to join. Ask an admin to change anyone’s role.'
            : 'You can see who has access and which teams they are on. Ask an admin to make changes.'}
      </p>

      <section>
        <label className="relative mb-2 block">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]"
          />
          <input
            type="search"
            className={cx(control, 'w-full py-1.5 pl-8 text-sm')}
            placeholder="Search by name, email, role or team"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search members"
          />
        </label>
        {needle && !members.isLoading && (
          <p className="mb-2 text-[11px] text-[var(--color-muted)]">
            {shown.length} of {everyone.length} {everyone.length === 1 ? 'member' : 'members'}
          </p>
        )}

        {members.isLoading ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--color-line)] px-3 py-6 text-center text-xs text-[var(--color-muted)]">
            Nobody matches “{search.trim()}”.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {shown.map((member) => (
              <li key={member.userId} className="flex items-start gap-3 px-3 py-2">
                <Avatar name={member.name} url={member.avatarUrl} seed={member.userId} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {member.name}
                    {member.isSelf && <span className="text-[var(--color-muted)]"> (you)</span>}
                  </p>
                  <p className="truncate text-[11px] text-[var(--color-muted)]">{member.email}</p>
                  <MemberTeams workspaceId={workspaceId} member={member} teams={teamList} mayChange={mayChangeTeam} />
                </div>

                {canManage && !(member.role === 'owner' && myRole !== 'owner') && roleList.length > 0 ? (
                  <select
                    className={control}
                    value={member.workspaceRole.id}
                    onChange={(e) => changeRole(member.userId, e.target.value)}
                    title={roleById.get(member.workspaceRole.id)?.description}
                    aria-label={`Role for ${member.name}`}
                  >
                    {/* Only an owner can hand out ownership. */}
                    {grantableRoles(roleList, myRole, can).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span
                    className="pt-1 text-xs text-[var(--color-muted)]"
                    title={roleById.get(member.workspaceRole.id)?.description}
                  >
                    {member.workspaceRole.name}
                  </span>
                )}

                {(canManage || member.isSelf) && (
                  <button
                    onClick={() =>
                      removeMember.mutate(member.userId, {
                        onSuccess: () => toast(member.isSelf ? 'You left the workspace' : 'Member removed'),
                        onError: (err) => toast(err instanceof Error ? err.message : 'Could not remove member', 'error'),
                      })
                    }
                    aria-label={member.isSelf ? 'Leave workspace' : `Remove ${member.name}`}
                    title={member.isSelf ? 'Leave workspace' : `Remove ${member.name}`}
                    className="px-1 pt-1 text-xs text-[var(--color-muted)] hover:text-red-500"
                  >
                    <Icon name="x-lg" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canInvite && invitable.length > 0 && (
        <>
          <section className="border-t border-[var(--color-line)] pt-3">
            <form onSubmit={submitInvite} className="flex gap-1.5">
              <input
                className={cx(control, 'min-w-0 flex-1')}
                placeholder="Email (optional for a shareable link)"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <select
                className={control}
                value={chosenInviteRole?.id ?? ''}
                onChange={(e) => setInviteRoleId(e.target.value)}
                title={chosenInviteRole?.description}
                aria-label="Role to invite with"
              >
                {invitable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <Button variant="primary" className="shrink-0 text-xs" type="submit" disabled={createInvite.isPending}>
                Invite
              </Button>
            </form>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Invite links are copied to your clipboard.
            </p>
          </section>

          {(invites.data ?? []).length > 0 && (
            <section>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Pending invites
              </p>
              <ul className="space-y-1">
                {(invites.data ?? []).map((invite) => (
                  <li key={invite.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {invite.email ?? 'Anyone with the link'}
                      <span className="text-[var(--color-muted)]"> · {invite.role.name}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                      expires {formatRelative(invite.expiresAt)}
                    </span>
                    <button onClick={() => copy(invite.token)} className="shrink-0 hover:text-[var(--color-accent)]">
                      Copy
                    </button>
                    <button
                      onClick={() => revokeInvite.mutate(invite.id, { onSuccess: () => toast('Invite revoked') })}
                      className="shrink-0 text-[var(--color-muted)] hover:text-red-500"
                      aria-label="Revoke invite"
                    >
                      <Icon name="x-lg" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The teams one person is on, as chips under their name. Whoever may change
 * their place on a team (see `mayChangeTeamMember`) can take them off it from
 * its chip, or pick teams from the list beside them.
 */
function MemberTeams({
  workspaceId,
  member,
  teams,
  mayChange,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  teams: Team[];
  mayChange: MayChangeTeam;
}) {
  const setTeams = useSetMemberTeams(workspaceId);
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const onTeams = teams.filter((team) => team.memberIds.includes(member.userId));
  const changeable = teams.filter((team) => mayChange(team, member.userId));
  const canManage = changeable.length > 0;
  if (!canManage && onTeams.length === 0) return null;

  function toggle(teamId: string, on: boolean) {
    const current = onTeams.map((team) => team.id);
    const teamIds = on ? [...current, teamId] : current.filter((id) => id !== teamId);
    setTeams.mutate(
      { userId: member.userId, teamIds },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change their teams', 'error') },
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {onTeams.map((team) => (
        <span
          key={team.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px]"
        >
          <Icon name="people-fill" className="text-[var(--color-muted)]" />
          <span className="truncate">{team.name}</span>
          {mayChange(team, member.userId) && (
            <button
              onClick={() => toggle(team.id, false)}
              disabled={setTeams.isPending}
              aria-label={`Take ${member.name} off ${team.name}`}
              title={`Take off ${team.name}`}
              className="text-[var(--color-muted)] hover:text-red-500 disabled:opacity-50"
            >
              <Icon name="x" />
            </button>
          )}
        </span>
      ))}

      {canManage && (
        <button
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          aria-expanded={anchor !== null}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          <Icon name="plus" />
          {onTeams.length ? 'Team' : 'Add to a team'}
        </button>
      )}

      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)}>
          <div className="w-60 p-2">
            <p className="mb-1 truncate px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Teams for {member.name}
            </p>
            {teams.length === 0 ? (
              <p className="px-1 py-2 text-xs text-[var(--color-muted)]">No teams yet. Create one under Teams.</p>
            ) : (
              <ul className="scroll-thin max-h-64 overflow-y-auto">
                {changeable.map((team) => (
                  <li key={team.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-surface)]">
                      <input
                        type="checkbox"
                        checked={team.memberIds.includes(member.userId)}
                        disabled={setTeams.isPending}
                        onChange={(e) => toggle(team.id, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate">{team.name}</span>
                      <span className="text-[11px] text-[var(--color-muted)]">{team.memberIds.length}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
