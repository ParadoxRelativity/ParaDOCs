import { desktop } from './desktop';
import { soundsEnabled } from './sounds';

/**
 * A notification from the browser, when it has been allowed to show them. The
 * desktop app raises its own through the operating system (notifier.ts in the
 * desktop app), so there this does nothing.
 */
export function notify({
  title,
  body,
  tag,
  onClick,
}: {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other rather than stacking. */
  tag: string;
  onClick: () => void;
}): void {
  if (desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    // The app plays its own sound for it; the system's would be a second one.
    const notification = new Notification(title, { body, tag, silent: soundsEnabled() });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some browsers refuse construction outside a service worker; a missing
    // notification must never break message delivery.
  }
}
