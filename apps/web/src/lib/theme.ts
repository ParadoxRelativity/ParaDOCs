import { createPreference } from './preference';

export type Theme = 'light' | 'dark' | 'system';

/**
 * The colour theme. Its page-storage key is also read by the script in
 * index.html, which applies it before first paint.
 */
const theme = createPreference<Theme>({
  key: 'theme',
  storageKey: 'paradocs.theme',
  fallback: 'system',
  isValid: (value): value is Theme => value === 'light' || value === 'dark' || value === 'system',
});

export const setTheme = theme.set;

export function useTheme(): [Theme, (theme: Theme) => void] {
  return theme.use();
}
