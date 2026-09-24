import { oidcErrorMessage } from '@paradocs/shared';
import { desktop } from './desktop';
import { isNativeApp, serverOrigin } from './server';

/**
 * Starting single sign-on from the sign-in screen, and finishing it.
 *
 * In a browser the page simply goes to the server's login address, and comes
 * back signed in with a cookie. The desktop and mobile apps' pages are not the
 * server's own, so they sign in through the system browser instead: they make
 * a verifier, send only its hash along, and when the browser hands back a
 * one-time code on a paradocs:// address, redeem the code with the verifier.
 * See the server's routes/oidc.ts.
 */

const VERIFIER_KEY = 'paradocs.ssoVerifier';

/** A sign-in the system browser handed back to the app. */
export interface SsoReturn {
  code?: string;
  /** An error code from the server; see oidcErrorMessage. */
  error?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Makes and keeps a new verifier, and returns the challenge that goes to the server. */
async function newChallenge(): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    localStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    // Storage blocked: redeeming will fail and say so.
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The verifier for the sign-in in progress. Kept until a code is redeemed with
 * it, not merely read: any web page can send the app a paradocs:// address, and
 * a made-up one must not use up the verifier the real sign-in needs.
 */
export function readVerifier(): string | null {
  try {
    return localStorage.getItem(VERIFIER_KEY);
  } catch {
    return null;
  }
}

/** Forgets the verifier once it has signed someone in. */
export function forgetVerifier(): void {
  try {
    localStorage.removeItem(VERIFIER_KEY);
  } catch {
    // Nothing to forget.
  }
}

function loginPath(slug: string): string {
  return `/api/auth/oidc/${encodeURIComponent(slug)}/login`;
}

/**
 * Starts signing in with a provider. `desktopServer` is the server's own
 * address, which in the desktop app the page cannot see from where it is.
 */
export async function startSso(slug: string, desktopServer?: string | null): Promise<void> {
  if (isNativeApp) {
    const url = `${serverOrigin()}${loginPath(slug)}?handoff=${await newChallenge()}`;
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
    return;
  }
  if (desktop && desktopServer) {
    // Opens in the system browser: the desktop app sends every other origin there.
    window.open(`${desktopServer}${loginPath(slug)}?handoff=${await newChallenge()}`, '_blank');
    return;
  }
  window.location.assign(loginPath(slug));
}

/** Parses what the system browser handed back, if it is a sign-in. */
export function parseSsoReturn(url: string): SsoReturn | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'paradocs:' || parsed.hostname !== 'auth') return null;
  return {
    code: parsed.searchParams.get('code') ?? undefined,
    error: parsed.searchParams.get('sso_error') ?? undefined,
  };
}

/**
 * Listens for sign-ins handed back to the app. In the mobile app that is the
 * paradocs:// address itself; the desktop app parses it and sends a command.
 */
export function onSsoReturn(handler: (result: SsoReturn) => void): () => void {
  if (desktop) {
    return desktop.onCommand((command) => {
      if (command.type === 'sso-return') handler({ code: command.code, error: command.error });
    });
  }
  if (!isNativeApp) return () => {};

  let stopped = false;
  let remove: (() => void) | undefined;
  void (async () => {
    const [{ App }, { Browser }] = await Promise.all([import('@capacitor/app'), import('@capacitor/browser')]);
    const listener = await App.addListener('appUrlOpen', ({ url }) => {
      const result = parseSsoReturn(url);
      if (!result) return;
      void Browser.close().catch(() => {});
      handler(result);
    });
    if (stopped) void listener.remove();
    else remove = () => void listener.remove();
  })();
  return () => {
    stopped = true;
    remove?.();
  };
}

/**
 * The message for an error the server sent a browser home with, taken off the
 * address so a reload does not show it again. The address carries only a code:
 * anyone can make a link with sso_error on it, so its text is never shown.
 */
export function takeBrowserSsoError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('sso_error');
  if (!error) return null;
  params.delete('sso_error');
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  return oidcErrorMessage(error);
}
