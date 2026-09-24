import path from 'node:path';
import { app } from 'electron';
import { sendCommand } from './windows.js';

/**
 * Single sign-on in the desktop app. The provider's pages open in the system
 * browser, never in a connection's window, and the server ends the sign-in on
 * a paradocs://auth address carrying a one-time code. The operating system
 * hands that address here, and it goes to the page on screen, which redeems
 * the code with a verifier only it holds. See the web client's lib/sso.ts.
 *
 * Any web page can send someone to a paradocs:// address, so nothing here
 * acts on one: it is passed along, and without the page's verifier the code
 * is worthless.
 */

const SCHEME = 'paradocs';

export function registerSignInScheme(): void {
  // Run unpackaged (`electron .`), the OS has to be told to start Electron
  // with this app's entry point, or the link would open a bare Electron.
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }
}

/** The sign-in address among a second launch's arguments, as Windows and Linux deliver it. */
export function signInAddressIn(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${SCHEME}://`));
}

/** Hands a paradocs:// address to the page on screen, if it is a sign-in. */
export function receiveSignInAddress(address: string): void {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== 'auth') return;
  sendCommand({
    type: 'sso-return',
    code: parsed.searchParams.get('code') ?? undefined,
    error: parsed.searchParams.get('sso_error') ?? undefined,
  });
}
