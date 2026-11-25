import { defineConfig } from 'vitest/config';

// Unit tests of the pages' pure modules (no DOM): `npm test --workspace=site`.
// Kept apart from vite.config.ts, which describes the multi-page build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
