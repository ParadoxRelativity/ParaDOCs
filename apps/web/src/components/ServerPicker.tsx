import { useState } from 'react';
import { normalizeServerUrl, serverOrigin, setServerOrigin } from '../lib/server';
import { Button } from './ui';

/**
 * The mobile app's first screen. A browser is always on its server, but the
 * app carries its own copy of the client and has to be told where the server
 * is before anything else can load.
 *
 * The address is checked against the server's health endpoint first, so a
 * typo or a server too old to accept the app is said here rather than as a
 * sign-in page that never works.
 */
export default function ServerPicker({ onCancel }: { onCancel?: () => void }) {
  const [address, setAddress] = useState(serverOrigin() ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let origin: string;
    try {
      origin = normalizeServerUrl(address);
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setChecking(true);
    try {
      const res = await fetch(`${origin}/api/health`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !body?.ok) throw new Error('not paradocs');
    } catch {
      // A server that refuses this app's origin fails the same way as one
      // that is not there at all; the browser does not say which.
      setError(
        `Could not reach a ParaDOCs server at ${origin}. Check the address, and that the server is up to date and allows the mobile app.`,
      );
      setChecking(false);
      return;
    }

    setServerOrigin(origin);
    // Start over on the new server: everything cached so far belongs to the
    // last one, and a clean load is the one way to be sure none of it lingers.
    window.location.replace('/');
  }

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm ' +
    'outline-none focus:border-[var(--color-accent)]';

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-surface)] p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-lg font-semibold tracking-tight">ParaDOCs</h1>
          <p className="text-sm text-[var(--color-muted)]">Connect to the server your workspace is on.</p>
        </div>

        <form onSubmit={(e) => void connect(e)} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Server address</span>
            <input
              className={field}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="docs.example.com"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              required
            />
          </label>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <Button variant="primary" className="w-full" type="submit" disabled={checking}>
            {checking ? 'Connecting…' : 'Connect'}
          </Button>
          {onCancel && (
            <Button variant="ghost" className="w-full" type="button" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
