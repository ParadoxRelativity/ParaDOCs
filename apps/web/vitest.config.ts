import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure library tests: exporters and importers run on bytes, with no browser.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
