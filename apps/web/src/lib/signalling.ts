import { ConnectionError, ConnectionErrorReason } from 'livekit-client';
import { serverOrigin, socketUrl } from './server';

/**
 * Where to dial LiveKit's signalling when the server relays it under /rtc:
 * this page's own origin, as a websocket address.
 *
 * The same reasoning as the chat socket. Only the page knows for certain the
 * address it was loaded from and whether over HTTPS — a reverse proxy, or the
 * desktop app's loopback proxy, can hide both from the server.
 */
export function sameOriginSignallingUrl(): string {
  // The mobile app is not served by its server, so it names the server instead.
  return socketUrl('');
}

/**
 * Says where a join could not get to, instead of the browser's bare "Failed to
 * fetch". Any other failure passes through as it is.
 */
export function explainJoinFailure(err: unknown, url: string): Error {
  if (err instanceof ConnectionError && err.reason === ConnectionErrorReason.ServerUnreachable) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Not a URL; name it as given.
    }
    return new Error(
      host === (serverOrigin() ? new URL(serverOrigin()!).host : window.location.host)
        ? 'Could not reach the voice service through this server. It may be stopped or still starting.'
        : `Could not reach the voice service at ${host}. If that address is from an earlier setup, remove LIVEKIT_URL from the server's .env.`,
    );
  }
  return err instanceof Error ? err : new Error('Could not join the call');
}
