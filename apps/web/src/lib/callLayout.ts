import { createPreference } from './preference';

/** Where the other videos in a call go when one is focused: a column beside it, or a row below. */
export type CallLayout = 'side' | 'bottom';

const callLayout = createPreference<CallLayout>({
  key: 'callLayout',
  storageKey: 'paradocs.callLayout',
  fallback: 'side',
  isValid: (value): value is CallLayout => value === 'side' || value === 'bottom',
});

export function useCallLayout(): [CallLayout, (layout: CallLayout) => void] {
  return callLayout.use();
}
