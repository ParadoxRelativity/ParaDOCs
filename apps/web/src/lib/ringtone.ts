import { loopSound } from './sounds';

/**
 * The ring for an incoming call, a seamless four-second loop from
 * `public/sounds/`. Returns a function that stops it.
 *
 * A browser that will not play sound before the page has been clicked simply
 * stays quiet; the call card still shows.
 */
export function startRingtone(): () => void {
  return loopSound('call_incoming');
}

/** What the caller hears while the other side rings, until it is answered or given up. */
export function startRingback(): () => void {
  return loopSound('call_outgoing');
}
