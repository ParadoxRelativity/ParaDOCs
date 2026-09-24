import { useEffect, useState } from 'react';
import { oidcErrorMessage, type OidcStatus } from '@paradocs/shared';
import { useLogin, useRegister, useSsoHandoff } from '../api/hooks';
import { ApiError } from '../api/client';
import { desktop, requireDesktop, useDesktopConnections } from '../lib/desktop';
import { isNativeApp, serverOrigin } from '../lib/server';
import { forgetVerifier, onSsoReturn, readVerifier, startSso, takeBrowserSsoError } from '../lib/sso';
import ServerPicker from './ServerPicker';
import ConnectServerDialog from './ConnectServerDialog';
import Icon from './Icon';
import { ConfirmDialog } from './Modal';
import { useToast } from './Toast';
import { Button } from './ui';
import { cx } from '../lib/util';

interface Props {
  allowRegistration: boolean;
  /** Off when the server signs in with single sign-on only. */
  passwordSignIn: boolean;
  oidc: OidcStatus;
}

export default function AuthScreen({ allowRegistration, passwordSignIn, oidc }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>(
    allowRegistration && passwordSignIn ? 'register' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [changingServer, setChangingServer] = useState(false);
  const login = useLogin();
  const register = useRegister();
  const handoff = useSsoHandoff();
  const [ssoError, setSsoError] = useState<string | null>(() => takeBrowserSsoError());
  const [ssoStarting, setSsoStarting] = useState(false);
  const connections = useDesktopConnections();
  // In the desktop app the provider is reached through the server's real
  // address, which only the connection knows; a workspace on this computer has none.
  const desktopServer = connections.find((c) => c.active)?.url ?? null;
  const ssoAvailable = oidc.providers.length > 0 && (!desktop || desktopServer !== null);

  const pending = login.isPending || register.isPending || handoff.isPending;
  const error = (login.error ?? register.error ?? handoff.error) as ApiError | null;

  // The desktop and mobile apps finish single sign-on here, when the system
  // browser hands the sign-in back.
  const redeem = handoff.mutate;
  useEffect(
    () =>
      onSsoReturn((result) => {
        setSsoStarting(false);
        if (result.error || !result.code) {
          setSsoError(oidcErrorMessage(result.error));
          return;
        }
        const verifier = readVerifier();
        if (!verifier) {
          setSsoError('That sign-in was not started from this app. Try again.');
          return;
        }
        setSsoError(null);
        redeem({ code: result.code, verifier }, { onSuccess: forgetVerifier });
      }),
    [redeem],
  );

  async function signInWith(slug: string) {
    setSsoError(null);
    setSsoStarting(true);
    try {
      await startSso(slug, desktopServer);
    } catch {
      setSsoError('Could not open the sign-in page.');
    }
    // A browser is leaving this page; the apps wait for the browser to come back.
    if (isNativeApp || desktop) setSsoStarting(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'login') login.mutate({ email, password });
    else register.mutate({ email, password, name });
  }

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm ' +
    'outline-none focus:border-[var(--color-accent)]';

  if (changingServer) return <ServerPicker onCancel={() => setChangingServer(false)} />;

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-lg font-semibold tracking-tight">ParaDOCs</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {mode === 'login' ? 'Sign in to your workspace.' : 'Create your account on this server.'}
          </p>
        </div>

        {passwordSignIn && (
          <form onSubmit={submit} className="space-y-3">
            {mode === 'register' && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Name</span>
                <input
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Email</span>
              <input
                className={field}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Password</span>
              <input
                className={field}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'register' ? 10 : 1}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
              {mode === 'register' && (
                <span className="mt-1 block text-xs text-[var(--color-muted)]">At least 10 characters.</span>
              )}
            </label>

            {error && !ssoError && <p className="text-sm text-red-500">{error.message}</p>}

            <Button variant="primary" className="w-full" type="submit" disabled={pending}>
              {pending ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        )}

        {ssoAvailable && (
          <div className={cx('space-y-2', passwordSignIn && 'mt-4 border-t border-[var(--color-line)] pt-4')}>
            {oidc.providers.map((provider) => (
              <Button
                key={provider.slug}
                variant="subtle"
                className="w-full justify-center border border-[var(--color-line)]"
                disabled={pending || ssoStarting}
                onClick={() => void signInWith(provider.slug)}
              >
                Sign in with {provider.name}
              </Button>
            ))}
            {(isNativeApp || desktop) && (
              <p className="text-center text-xs text-[var(--color-muted)]">
                Opens your browser, then comes back here.
              </p>
            )}
          </div>
        )}
        {ssoError && <p className="mt-3 text-sm text-red-500">{ssoError}</p>}
        {/* Password errors show inside the form; with no form, a redeem error shows here. */}
        {!passwordSignIn && error && !ssoError && <p className="mt-3 text-sm text-red-500">{error.message}</p>}
        {!passwordSignIn && !ssoAvailable && (
          <p className="text-sm text-[var(--color-muted)]">
            This server signs in with single sign-on, which is not available here. Contact the server administrator.
          </p>
        )}

        {allowRegistration && passwordSignIn && (
          <button
            className="mt-4 w-full text-center text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
          </button>
        )}

        {desktop && <DesktopPlaces />}

        {/* The mobile app signs in to one server at a time, chosen before this. */}
        {isNativeApp && (
          <div className="mt-4 border-t border-[var(--color-line)] pt-4 text-xs text-[var(--color-muted)]">
            <p className="mb-2 truncate">
              Signing in to <span className="text-[var(--color-ink)]">{serverOrigin()}</span>
            </p>
            <Button variant="subtle" className="text-xs" onClick={() => setChangingServer(true)}>
              <Icon name="hdd-network" /> Change server
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * In the desktop app a sign-in page belongs to one server among several, and
 * the workspace menu that switches between them only appears once signed in.
 * This keeps the other places, and adding one, within reach from here.
 */
function DesktopPlaces() {
  const connections = useDesktopConnections();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const here = connections.find((c) => c.active);
  const others = connections.filter((c) => !c.active);

  async function open(id: string) {
    const result = await requireDesktop().connections.open(id);
    if (!result.ok) toast(result.error, 'error');
  }

  async function removeHere() {
    setRemoving(false);
    if (!here) return;
    const result = await requireDesktop().connections.remove(here.id);
    if (!result.ok) toast(result.error, 'error');
  }

  return (
    <div className="mt-4 border-t border-[var(--color-line)] pt-4 text-xs text-[var(--color-muted)]">
      {here?.kind === 'remote' && (
        <p className="mb-2 truncate">
          Signing in to <span className="text-[var(--color-ink)]">{here.url}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {others.map((connection) => (
          <Button key={connection.id} variant="subtle" className="text-xs" onClick={() => void open(connection.id)}>
            <Icon name={connection.kind === 'local' ? 'laptop' : 'globe2'} /> {connection.label}
          </Button>
        ))}
        <Button variant="subtle" className="text-xs" onClick={() => setConnecting(true)}>
          <Icon name="hdd-network" /> Connect to a server
        </Button>
      </div>
      {here?.kind === 'remote' && others.length > 0 && (
        <button type="button" className="mt-3 hover:text-red-500" onClick={() => setRemoving(true)}>
          Remove this server
        </button>
      )}

      {connecting && <ConnectServerDialog onClose={() => setConnecting(false)} />}
      {removing && here && (
        <ConfirmDialog
          title={`Remove ${here.label}?`}
          description="Nothing on the server is deleted."
          confirmLabel="Remove"
          onConfirm={() => void removeHere()}
          onCancel={() => setRemoving(false)}
        />
      )}
    </div>
  );
}
