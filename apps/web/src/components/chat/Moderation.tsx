import { useState, type FormEvent } from 'react';
import { useBlocks, useReportMessage, useSetBlocked } from '../../api/hooks';
import { formatRelative } from '../../lib/util';
import Avatar from '../Avatar';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, Spinner } from '../ui';

/**
 * Reporting a message and blocking a person: the least moderation the app
 * stores ask of an app where people post things. The server's side is
 * routes/moderation.ts in the API.
 */

/** Reports a message to the owners and admins of the workspace, with an optional reason. */
export function ReportMessageDialog({
  messageId,
  authorName,
  direct,
  onClose,
}: {
  messageId: string;
  authorName: string;
  /** In a direct conversation, which the admins are not part of. */
  direct: boolean;
  onClose: () => void;
}) {
  const report = useReportMessage();
  const toast = useToast();
  const [reason, setReason] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    report.mutate(
      { messageId, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast('Reported to the workspace’s owners and admins');
          onClose();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not report the message', 'error'),
      },
    );
  }

  return (
    <Modal
      title={`Report ${authorName}’s message?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" className="border border-red-500/40" type="submit" form="report-message" disabled={report.isPending}>
            {report.isPending ? 'Reporting…' : 'Report'}
          </Button>
        </>
      }
    >
      <form id="report-message" onSubmit={submit} className="space-y-3">
        <p className="text-sm">
          The owners and admins of this workspace are told, and see the message, who sent it, and your name and reason.
          {direct && ' They are not part of this conversation, so this message is all they see of it.'}{' '}
          {authorName} is not told.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">What’s wrong with it? (optional)</span>
          <textarea
            className={FIELD}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          This server’s operator and the workspace’s admins moderate what is said on it. To stop seeing this person,
          block them too.
        </p>
      </form>
    </Modal>
  );
}

/** Blocks or unblocks someone, after saying what that does. */
export function BlockDialog({
  user,
  blocked,
  onClose,
}: {
  user: { id: string; name: string };
  /** Whether they are blocked now, which makes this the way to unblock them. */
  blocked: boolean;
  onClose: () => void;
}) {
  const setBlocked = useSetBlocked();
  const toast = useToast();

  function confirm() {
    setBlocked.mutate(
      { userId: user.id, blocked: !blocked },
      {
        onSuccess: () => {
          toast(blocked ? `Unblocked ${user.name}` : `Blocked ${user.name}`);
          onClose();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the block', 'error'),
      },
    );
  }

  return (
    <Modal
      title={blocked ? `Unblock ${user.name}?` : `Block ${user.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={blocked ? 'primary' : 'danger'}
            className={blocked ? undefined : 'border border-red-500/40'}
            disabled={setBlocked.isPending}
            onClick={confirm}
            autoFocus
          >
            {blocked ? 'Unblock' : 'Block'}
          </Button>
        </>
      }
    >
      {blocked ? (
        <p className="text-sm">
          You’ll see {user.name}’s messages and mentions again, and they can message and call you directly.
        </p>
      ) : (
        <>
          <p className="text-sm">
            Their messages are hidden from you, their mentions stop notifying you, and they can’t message or call you
            directly. This applies in every workspace on this server, on all your devices.
          </p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {user.name} isn’t told. Other people still see what they post. You can unblock them from Settings → Account.
            If they are breaking the rules, report their messages as well.
          </p>
        </>
      )}
    </Modal>
  );
}

/** Settings' list of the people you blocked, each with a way to unblock them. */
export function BlockedPeople() {
  const blocks = useBlocks();
  const [unblocking, setUnblocking] = useState<{ id: string; name: string } | null>(null);

  if (blocks.isLoading) return <Spinner />;
  const people = blocks.data ?? [];
  if (people.length === 0) {
    return <p className="text-xs text-[var(--color-muted)]">You haven’t blocked anyone.</p>;
  }

  return (
    <>
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {people.map((person) => (
          <li key={person.id} className="flex items-center gap-2.5 px-3 py-2">
            <Avatar name={person.name} url={person.avatarUrl} seed={person.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{person.name}</span>
              <span className="block text-[11px] text-[var(--color-muted)]">
                Blocked {formatRelative(person.blockedAt)}
              </span>
            </span>
            <Button variant="subtle" className="text-xs" onClick={() => setUnblocking(person)}>
              Unblock
            </Button>
          </li>
        ))}
      </ul>
      {unblocking && <BlockDialog user={unblocking} blocked onClose={() => setUnblocking(null)} />}
    </>
  );
}
