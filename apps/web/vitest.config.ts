import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure library tests: the importers run on bytes, with no browser.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
