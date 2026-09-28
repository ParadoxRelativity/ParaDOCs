import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { User } from '@paradocs/shared';
import { useOAuthClient, useOAuthDecision, useWorkspaces } from '../api/hooks';
import { cx } from '../lib/util';
import Icon from './Icon';
import { FIELD_BASE } from './SettingsParts';
import { useToast } from './Toast';
import { Button, EmptyState, Spinner } from './ui';

/** Kept while someone signs in with single sign-on, which returns them to the start page. */
const PENDING_KEY = 'paradocs.connectAi';

/** Remembers a sign-in request that arrived before its person had signed in to ParaDOCs. */
export function rememberConnectRequest(): void {
  if (window.location.pathname !== '/connect-ai') return;
  try {
    sessionStorage.setItem(PENDING_KEY, window.location.search);
  } catch {
    // Without storage, someone signing in by SSO has to connect again; a password sign-in never leaves the page.
  }
}

/** Where to go back to once signed in, if an assistant was waiting; taken, so it happens once. */
export function takeConnectRequest(): string | null {
  try {
    const search = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return search ? `/connect-ai${search}` : null;
  } catch {
    return null;
  }
}

/**
 * The consent page an AI assistant sends someone to when it connects by
 * signing in, as claude.ai and ChatGPT do. They see which app is asking and
 * where it will send them back, choose what it may reach, and approve or
 * refuse. Either way they are sent back to the app.
 */
export default function ConnectAi({ user }: { user: User }) {
  const [params] = useSearchParams();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const client = useOAuthClient(clientId, redirectUri);
  const workspaces = useWorkspaces();
  const decide = useOAuthDecision();
  const toast = useToast();
  const [workspaceId, setWorkspaceId] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [leaving, setLeaving] = useState(false);

  if (client.isLoading) return <Spinner />;
  if (client.error || !client.data) {
    return (
      <EmptyState
        icon="robot"
        title="This connection request is not valid"
        hint={client.error instanceof Error ? client.error.message : 'Start connecting again from the app.'}
      />
    );
  }

  function answer(approve: boolean) {
    decide.mutate(
      {
        clientId,
        redirectUri,
        codeChallenge: params.get('code_challenge') ?? '',
        codeChallengeMethod: 'S256',
        state: params.get('state') ?? undefined,
        approve,
        workspaceId: workspaceId || null,
        canWrite,
      },
      {
        onSuccess: ({ redirectTo }) => {
          setLeaving(true);
          window.location.assign(redirectTo);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not answer the request', 'error'),
      },
    );
  }

  const { clientName, redirectHost } = client.data;
  const busy = decide.isPending || leaving;

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <div className="flex justify-center text-3xl text-[var(--color-accent)]">
          <Icon name="robot" />
        </div>
        <h1 className="mt-2 text-center text-lg font-semibold">Connect {clientName} to ParaDOCs?</h1>
        <p className="mt-1 text-center text-sm text-[var(--color-muted)]">
          It will act as you, {user.name}, and see only what you can. You will be sent back to{' '}
          <span className="font-medium text-[var(--color-ink)]">{redirectHost}</span>.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">What it can reach</span>
            <select className={cx(FIELD_BASE, 'w-full')} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">Every workspace you are in</option>
              {(workspaces.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  Only {w.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="mb-1 text-xs text-[var(--color-muted)]">What it can do</legend>
            <label className="flex cursor-pointer items-start gap-2 py-0.5">
              <input type="radio" className="mt-1" checked={!canWrite} onChange={() => setCanWrite(false)} />
              <span>
                Read only
                <span className="block text-xs text-[var(--color-muted)]">Search and read documents, boards and chat.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 py-0.5">
              <input type="radio" className="mt-1" checked={canWrite} onChange={() => setCanWrite(true)} />
              <span>
                Read and change
                <span className="block text-xs text-[var(--color-muted)]">
                  Also write documents, add and move work items, comment and post messages, as you.
                </span>
              </span>
            </label>
          </fieldset>
        </div>

        <div className="mt-5 flex gap-2">
          <Button variant="subtle" className="flex-1 justify-center text-xs" disabled={busy} onClick={() => answer(false)}>
            Deny
          </Button>
          <Button variant="primary" className="flex-1 justify-center text-xs" disabled={busy} onClick={() => answer(true)}>
            {busy ? 'Connecting…' : 'Allow'}
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-[var(--color-muted)]">
          You can revoke it any time under Settings → AI connections.
        </p>
      </div>
    </div>
  );
}
