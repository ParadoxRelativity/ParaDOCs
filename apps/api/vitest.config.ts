import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each file boots the API on its own in-memory database.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
