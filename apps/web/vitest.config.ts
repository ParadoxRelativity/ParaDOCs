import { defineConfig } from 'vitest/config';

// Unit tests of plain TypeScript (exporters and the like); nothing here needs a DOM.
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
