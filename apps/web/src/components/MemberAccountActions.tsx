import { useState, type FormEvent } from 'react';
import type { AccountRequestKind, WorkspaceMember } from '@paradocs/shared';
import { useRequestMemberAccount, useSetMemberSuspended } from '../api/hooks';
import { FIELD } from './SettingsParts';
import Icon, { type IconName } from './Icon';
import { Modal } from './Modal';
import { Popover } from './Popover';
import { useToast } from './Toast';
import { Button } from './ui';

/**
 * A team lead's menu on one member. Within this workspace they can suspend
 * someone, or lift it. Beyond it they can only ask the server's administrators
 * to disable or delete the account, which reaches every workspace and is
 * theirs to decide.
 *
 * Shown only to someone who may, as `mayManageMemberAccount` decides; the
 * server holds them to the same rule, and refuses requests about server
 * administrators, which only it can tell.
 */
export default function MemberAccountActions({ workspaceId, member }: { workspaceId: string; member: WorkspaceMember }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<'suspend' | AccountRequestKind | null>(null);
  const setSuspended = useSetMemberSuspended(workspaceId);
  const toast = useToast();

  const suspended = Boolean(member.suspension);
  // Deleting goes further than disabling, so once it is asked for there is nothing more to ask.
  const mayAskDisable = !member.disabled && !member.accountRequest;
  const mayAskDelete = member.accountRequest !== 'delete';

  function lift() {
    setSuspended.mutate(
      { userId: member.userId, suspended: false },
      {
        onSuccess: () => toast(`${member.name} is back in the workspace`),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not lift the suspension', 'error'),
      },
    );
  }

  const item = (icon: IconName, label: string, run: () => void, danger = false) => (
    <button
      className={
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ' +
        (danger ? 'text-red-500 hover:bg-red-500/10' : 'hover:bg-[var(--color-surface)]')
      }
      onClick={() => {
        setAnchor(null);
        run();
      }}
    >
      <Icon name={icon} className={danger ? undefined : 'text-[var(--color-muted)]'} /> {label}
    </button>
  );

  return (
    <>
      <button
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-label={`Access actions for ${member.name}`}
        title="Access actions"
        aria-expanded={anchor !== null}
        className="px-1 pt-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <Icon name="three-dots-vertical" />
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)}>
          <div className="w-64 p-1">
            {suspended
              ? item('arrow-counterclockwise', 'Lift suspension', lift)
              : item('pause-circle', 'Suspend from this workspace…', () => setDialog('suspend'), true)}
            {(mayAskDisable || mayAskDelete) && (
              <p className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Ask the server administrators
              </p>
            )}
            {mayAskDisable && item('slash-circle', 'Disable account…', () => setDialog('disable'))}
            {mayAskDelete && item('person-x', 'Delete account…', () => setDialog('delete'))}
          </div>
        </Popover>
      )}
      {dialog === 'suspend' && (
        <SuspendDialog workspaceId={workspaceId} member={member} onClose={() => setDialog(null)} />
      )}
      {(dialog === 'disable' || dialog === 'delete') && (
        <AccountRequestDialog workspaceId={workspaceId} member={member} kind={dialog} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function SuspendDialog({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  onClose: () => void;
}) {
  const setSuspended = useSetMemberSuspended(workspaceId);
  const toast = useToast();

  function suspend() {
    setSuspended.mutate(
      { userId: member.userId, suspended: true },
      {
        onSuccess: () => {
          toast(`${member.name} is suspended from this workspace`);
          onClose();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not suspend them', 'error'),
      },
    );
  }

  return (
    <Modal
      title={`Suspend ${member.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" className="border border-red-500/40" disabled={setSuspended.isPending} onClick={suspend}>
            {setSuspended.isPending ? 'Suspending…' : 'Suspend'}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        {member.name} won’t be able to open this workspace, and anything of it they have open closes now. Their account
        and their other workspaces are not affected.
      </p>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Their role, teams and access are kept, so lifting the suspension brings them back to what they had. They are
        told who suspended them.
      </p>
    </Modal>
  );
}

function AccountRequestDialog({
  workspaceId,
  member,
  kind,
  onClose,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  kind: AccountRequestKind;
  onClose: () => void;
}) {
  const request = useRequestMemberAccount(workspaceId);
  const toast = useToast();
  const [note, setNote] = useState('');
  const verb = kind === 'disable' ? 'disable' : 'delete';

  function submit(e: FormEvent) {
    e.preventDefault();
    request.mutate(
      { userId: member.userId, kind, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast(`Asked the server administrators to ${verb} ${member.name}’s account`);
          onClose();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not send the request', 'error'),
      },
    );
  }

  return (
    <Modal
      title={`Ask to ${verb} ${member.name}’s account?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="member-account-request" disabled={request.isPending}>
            {request.isPending ? 'Sending…' : 'Send request'}
          </Button>
        </>
      }
    >
      <form id="member-account-request" onSubmit={submit} className="space-y-3">
        <p className="text-sm">
          {kind === 'disable'
            ? `The server administrators are asked to disable ${member.name}’s account, which would sign them out and lock them out of every workspace on this server.`
            : `The server administrators are asked to delete ${member.name}’s account and what it holds, across this server.`}{' '}
          They decide.
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          {member.name} is told, with your name and your note, and can add a note of their own for the administrators.
          To keep them out of this workspace in the meantime, suspend them.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Note for the administrators (optional)</span>
          <textarea
            className={FIELD}
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
        </label>
      </form>
    </Modal>
  );
}
