import { createPreference } from './preference';

/**
 * Update notices someone has set aside. Each entry names one release, so
 * dismissing an update never hides the one after it.
 */
const dismissedUpdates = createPreference<string[]>({
  key: 'dismissedUpdates',
  storageKey: 'paradocs.dismissedUpdates',
  fallback: [],
  isValid: (value): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
});

export function useDismissedUpdates(): { isDismissed: (key: string) => boolean; dismiss: (key: string) => void } {
  const [dismissed, setDismissed] = dismissedUpdates.use();
  return {
    isDismissed: (key) => dismissed.includes(key),
    // Only the most recent few are worth keeping; older releases never come back.
    dismiss: (key) => setDismissed([...dismissed.filter((entry) => entry !== key), key].slice(-50)),
  };
}
