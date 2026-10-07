import { useState, type FormEvent } from 'react';
import type { AccountRequestStatus } from '@paradocs/shared';
import {
  useAccountDeletion,
  useCancelAccountDeletion,
  useRequestAccountDeletion,
  useSaveAccountMemberNote,
} from '../api/hooks';
import { formatDateTime } from '../lib/util';
import { FIELD } from './SettingsParts';
import { useToast } from './Toast';
import { Button, Spinner } from './ui';

/**
 * Asking this server's administrators to delete your account, or taking that
 * back. Settings shows it, and so does /account/delete, the address the app
 * stores list for deleting an account from outside the app.
 *
 * It is a request rather than a deletion because an account's workspaces go
 * with it, and one other people still use has to be handed over first, which
 * only an administrator can decide. The wording says so, as the stores expect.
 */
export default function AccountDeletion() {
  const status = useAccountDeletion();
  const request = useRequestAccountDeletion();
  const cancel = useCancelAccountDeletion();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');

  if (status.isLoading) return <Spinner />;
  if (!status.data) {
    return <p className="text-xs text-red-500">Could not check for a deletion request. Try again later.</p>;
  }

  if (status.data.requestedAt && status.data.requestedBy) {
    return <LeadRequest status={status.data} />;
  }

  if (status.data.requestedAt) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3">
        <p className="text-sm">
          You asked for this account to be deleted on {formatDateTime(status.data.requestedAt)}. An administrator of
          this server has been told and will delete it.
        </p>
        {status.data.note && <p className="mt-1 text-xs text-[var(--color-muted)]">Your note: {status.data.note}</p>}
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          You can keep using ParaDOCs until then. If you change your mind, cancel the request.
        </p>
        <Button
          variant="subtle"
          className="mt-2 text-xs"
          disabled={cancel.isPending}
          onClick={() =>
            cancel.mutate(undefined, {
              onSuccess: () => toast('Deletion request cancelled'),
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not cancel the request', 'error'),
            })
          }
        >
          {cancel.isPending ? 'Cancelling…' : 'Cancel request'}
        </Button>
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    request.mutate(
      { note: note.trim() || undefined, password: status.data?.hasPassword ? password : undefined },
      {
        onSuccess: () => {
          setNote('');
          setPassword('');
          toast('Deletion requested. The server administrators have been told.');
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not send the request', 'error'),
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="text-xs text-[var(--color-muted)]">
        This asks the administrators of this server to delete your account and what it holds: your profile, and the
        workspaces you created with their documents, sheets, messages and files. Workspaces other people still use may
        need to be handed over to someone first. Deletion can't be undone. How soon it happens is up to the
        administrators.
      </p>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--color-muted)]">Note for the administrators (optional)</span>
        <textarea
          className={FIELD}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example, who should get your workspaces"
        />
      </label>
      {status.data.hasPassword && (
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Current password</span>
          <input
            className={FIELD}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
      )}
      <Button variant="danger" type="submit" className="border border-red-500/40 text-xs" disabled={request.isPending}>
        {request.isPending ? 'Sending…' : 'Request deletion'}
      </Button>
    </form>
  );
}

/**
 * A team lead asked the administrators to disable or delete this account. You
 * cannot withdraw it, since only a server administrator can set a lead's
 * request aside, but you can tell them what you think of it.
 */
function LeadRequest({ status }: { status: AccountRequestStatus }) {
  const saveNote = useSaveAccountMemberNote();
  const toast = useToast();
  const [note, setNote] = useState(status.memberNote ?? '');
  const by = status.requestedBy!;
  const where = by.workspaceName ? ` (from ${by.workspaceName})` : '';

  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3">
      <p className="text-sm">
        {by.name}
        {where} asked the administrators of this server to {status.kind === 'disable' ? 'disable' : 'delete'} this
        account on {formatDateTime(status.requestedAt!)}. They have been told and will decide.
      </p>
      {status.note && <p className="mt-1 text-xs text-[var(--color-muted)]">Their note: {status.note}</p>}
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        You can keep using ParaDOCs until then. Only an administrator can set this request aside; if you disagree, or
        want something kept, tell them here.
      </p>
      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveNote.mutate(note.trim(), {
            onSuccess: () => toast('Your note was sent to the administrators'),
            onError: (err) => toast(err instanceof Error ? err.message : 'Could not save your note', 'error'),
          });
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Your note for the administrators</span>
          <textarea
            className={FIELD}
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Button
          variant="subtle"
          type="submit"
          className="text-xs"
          disabled={saveNote.isPending || note.trim() === (status.memberNote ?? '')}
        >
          {saveNote.isPending ? 'Saving…' : 'Save note'}
        </Button>
      </form>
    </div>
  );
}
