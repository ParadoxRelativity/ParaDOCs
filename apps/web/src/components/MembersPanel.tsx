import { useState } from 'react';
import type { Role } from '@paradocs/shared';
import {
  useCreateInvite,
  useInvites,
  useMembers,
  useRemoveMember,
  useUpdateMember,
} from '../api/hooks';
import { useRevokeInvite } from '../api/hooks';
import { cx, formatRelative } from '../lib/util';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace',
  admin: 'Manage members and all content',
  editor: 'Create and edit documents',
  viewer: 'Read and comment only',
};

interface Props {
  workspaceId: string;
  myRole: Role;
}

/** Member list and invite management. Rendered inside the settings dialog. */
export default function MembersPanel({ workspaceId, myRole }: Props) {
  const canManage = myRole === 'owner' || myRole === 'admin';
  const members = useMembers(workspaceId);
  const invites = useInvites(workspaceId, canManage);
  const updateMember = useUpdateMember(workspaceId);
  const removeMember = useRemoveMember(workspaceId);
  const createInvite = useCreateInvite(workspaceId);
  const revokeInvite = useRevokeInvite(workspaceId);
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');

  const control =
    'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';

  function inviteLink(token: string) {
    return `${window.location.origin}/invite/${token}`;
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
      const invite = await createInvite.mutateAsync({ email: email.trim() || null, role });
      setEmail('');
      await copy(invite.token);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create invite', 'error');
    }
  }

  function changeRole(userId: string, next: Role) {
    updateMember.mutate(
      { userId, role: next },
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
          ? 'Invite people by email, or create a link anyone can use to join.'
          : 'You can see who has access. Ask an admin to make changes.'}
      </p>
        <section>
          {members.isLoading ? (
            <Spinner />
          ) : (
            <ul className="space-y-1">
              {(members.data ?? []).map((member) => (
                <li key={member.userId} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {member.name}
                      {member.isSelf && <span className="text-[var(--color-muted)]"> (you)</span>}
                    </p>
                    <p className="truncate text-[11px] text-[var(--color-muted)]">{member.email}</p>
                  </div>

                  {canManage && !(member.role === 'owner' && myRole !== 'owner') ? (
                    <select
                      className={control}
                      value={member.role}
                      onChange={(e) => changeRole(member.userId, e.target.value as Role)}
                      title={ROLE_HELP[member.role]}
                    >
                      {/* Only an owner can hand out ownership. */}
                      {(myRole === 'owner' ? (['owner', 'admin', 'editor', 'viewer'] as Role[]) : (['admin', 'editor', 'viewer'] as Role[])).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-[var(--color-muted)]" title={ROLE_HELP[member.role]}>
                      {member.role}
                    </span>
                  )}

                  {(canManage || member.isSelf) && (
                    <button
                      onClick={() =>
                        removeMember.mutate(member.userId, {
                          onSuccess: () => toast(member.isSelf ? 'You left the workspace' : 'Member removed'),
                          onError: (err) =>
                            toast(err instanceof Error ? err.message : 'Could not remove member', 'error'),
                        })
                      }
                      aria-label={member.isSelf ? 'Leave workspace' : `Remove ${member.name}`}
                      title={member.isSelf ? 'Leave workspace' : `Remove ${member.name}`}
                      className="px-1 text-xs text-[var(--color-muted)] hover:text-red-500"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && (
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
                <select className={control} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="admin">admin</option>
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
                <Button variant="primary" className="shrink-0 text-xs" type="submit" disabled={createInvite.isPending}>
                  Invite
                </Button>
              </form>
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                This server does not send email. Creating an invite copies its link to your clipboard.
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
                        <span className="text-[var(--color-muted)]"> · {invite.role}</span>
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                        expires {formatRelative(invite.expiresAt)}
                      </span>
                      <button onClick={() => copy(invite.token)} className="shrink-0 hover:text-[var(--color-accent)]">
                        Copy
                      </button>
                      <button
                        onClick={() =>
                          revokeInvite.mutate(invite.id, { onSuccess: () => toast('Invite revoked') })
                        }
                        className="shrink-0 text-[var(--color-muted)] hover:text-red-500"
                        aria-label="Revoke invite"
                      >
                        ×
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
