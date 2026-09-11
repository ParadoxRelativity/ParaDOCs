import { useEffect, useRef, useState } from 'react';
import type { PresenceStatus } from '@paradocs/shared';

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const CHECK_INTERVAL_MS = 15_000;

/**
 * Whether the person has stopped using this window: no pointer, key or scroll
 * for `awayAfterMinutes`. Zero never goes idle, and nor does someone who is
 * `engaged` — sitting in a call is being around, hands on the keyboard or not.
 *
 * Activity is heard in the capture phase, so an editor that stops a key event
 * from bubbling still counts as someone typing.
 */
export function useIdle(awayAfterMinutes: number, engaged: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const idleRef = useRef(false);
  const lastActive = useRef(Date.now());

  useEffect(() => {
    const onActivity = () => {
      lastActive.current = Date.now();
      if (!idleRef.current) return;
      idleRef.current = false;
      setIdle(false);
    };
    const options = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, options);
    window.addEventListener('focus', onActivity);

    if (awayAfterMinutes <= 0) {
      idleRef.current = false;
      setIdle(false);
    }
    const timer = setInterval(() => {
      if (awayAfterMinutes <= 0 || idleRef.current) return;
      if (Date.now() - lastActive.current < awayAfterMinutes * 60_000) return;
      idleRef.current = true;
      setIdle(true);
    }, CHECK_INTERVAL_MS);

    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, options);
      window.removeEventListener('focus', onActivity);
      clearInterval(timer);
    };
  }, [awayAfterMinutes]);

  return idle && !engaged;
}

/**
 * How someone's own status shows to them. Worked out here as well as on the
 * server so the dot under your name changes the moment you go idle or come
 * back, rather than after a round trip.
 */
export function effectiveStatus(chosen: PresenceStatus, idle: boolean): PresenceStatus {
  return chosen === 'online' && idle ? 'away' : chosen;
}
