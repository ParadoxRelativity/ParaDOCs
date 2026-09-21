import { useSyncExternalStore } from 'react';

/**
 * Below this width the app is one column at a time: the sidebar is the menu,
 * and choosing something from it replaces the menu with that thing until you
 * go back. Matches Tailwind's `md` breakpoint.
 */
const NARROW_QUERY = '(max-width: 767px)';

const narrowMedia = typeof window !== 'undefined' ? window.matchMedia(NARROW_QUERY) : null;

function subscribeNarrow(onChange: () => void) {
  narrowMedia?.addEventListener('change', onChange);
  return () => narrowMedia?.removeEventListener('change', onChange);
}

/** Whether the window is phone-width, following it as it resizes or rotates. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => narrowMedia?.matches ?? false);
}

/**
 * Which of the two the phone layout is showing. It lives outside any component
 * because moving between apps swaps the route the workspace view is rendered
 * under, and where you were in the menu should not be lost when that happens.
 */
export type MobilePane = 'menu' | 'content';

// A link or a remembered tab that names something opens on that thing; only
// the workspace's front door starts on the menu.
let pane: MobilePane =
  typeof window !== 'undefined' && /^\/w\/[^/]+\/(d|s|c|p|all|access)\/?/.test(window.location.pathname)
    ? 'content'
    : 'menu';
const paneListeners = new Set<() => void>();

export function setMobilePane(next: MobilePane) {
  if (next === pane) return;
  pane = next;
  paneListeners.forEach((listener) => listener());
}

export function useMobilePane(): MobilePane {
  return useSyncExternalStore(
    (onChange) => {
      paneListeners.add(onChange);
      return () => paneListeners.delete(onChange);
    },
    () => pane,
  );
}
