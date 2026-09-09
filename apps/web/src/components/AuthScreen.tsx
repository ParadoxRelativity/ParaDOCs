import { useState } from 'react';
import { useLogin, useRegister } from '../api/hooks';
import { ApiError } from '../api/client';
import { Button } from './ui';

interface Props {
  allowRegistration: boolean;
  oidc: { enabled: boolean; configured: boolean; providerName: string };
}

export default function AuthScreen({ allowRegistration, oidc }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>(allowRegistration ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const login = useLogin();
  const register = useRegister();

  const pending = login.isPending || register.isPending;
  const error = (login.error ?? register.error) as ApiError | null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'login') login.mutate({ email, password });
    else register.mutate({ email, password, name });
  }

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm ' +
    'outline-none focus:border-[var(--color-accent)]';

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-lg font-semibold tracking-tight">ParaDOCs</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {mode === 'login' ? 'Sign in to your workspace.' : 'Create your account on this server.'}
          </p>
        </div>

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

          {error && <p className="text-sm text-red-500">{error.message}</p>}

          <Button variant="primary" className="w-full" type="submit" disabled={pending}>
            {pending ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        {/* SSO is stubbed until Phase 2; shown only where an operator configured it. */}
        {oidc.configured && (
          <div className="mt-4 border-t border-[var(--color-line)] pt-4">
            <button
              type="button"
              disabled={!oidc.enabled}
              title={oidc.enabled ? undefined : 'Single sign-on is not implemented yet'}
              className="w-full rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Sign in with {oidc.providerName}
            </button>
            {!oidc.enabled && (
              <p className="mt-1 text-center text-xs text-[var(--color-muted)]">
                Single sign-on is configured but not implemented yet.
              </p>
            )}
          </div>
        )}

        {allowRegistration && (
          <button
            className="mt-4 w-full text-center text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
          </button>
        )}
      </div>
    </div>
  );
}
