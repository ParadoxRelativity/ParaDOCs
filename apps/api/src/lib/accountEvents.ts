/**
 * Word that someone's sessions have ended from outside their own browser: an
 * administrator disabled the account, reset its password, or signed it out.
 *
 * Deleting session rows stops new requests, but a socket opened before then
 * was authenticated once, at its handshake. The parts of the server holding
 * sockets listen here and close them, so the change takes effect now rather
 * than whenever the connection next drops.
 */

type Listener = (userId: string) => void;

const listeners = new Set<Listener>();

export function onSignedOut(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function signedOut(userId: string): void {
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      // One listener failing must not keep the others from closing theirs.
    }
  }
}
