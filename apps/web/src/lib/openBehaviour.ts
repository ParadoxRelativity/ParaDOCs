import { createPreference } from './preference';

/**
 * What clicking a notification does: go there in the tab you are in, or open it
 * in one of its own.
 *
 * Both are reasonable defaults and people are firm about which they want. One
 * treats a notification as an interruption to deal with and come back from, the
 * other as somewhere to go; neither is right for everybody, so it is asked
 * rather than assumed.
 */
export type OpenBehaviour = 'here' | 'tab';

const openNotifications = createPreference<OpenBehaviour>({
  key: 'openNotifications',
  storageKey: 'paradocs.openNotifications',
  fallback: 'here',
  isValid: (value): value is OpenBehaviour => value === 'here' || value === 'tab',
});

/** Read outside React, by handlers that only need the value at the moment of the click. */
export const getOpenBehaviour = openNotifications.get;

export function useOpenBehaviour(): [OpenBehaviour, (next: OpenBehaviour) => void] {
  return openNotifications.use();
}
