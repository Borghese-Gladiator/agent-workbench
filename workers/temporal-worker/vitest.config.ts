import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The self-booting e2e tests (run-phase-e2e) start a real Temporal test server per case, so give
    // them the same 60s headroom their per-test/beforeAll timeouts already assume.
    testTimeout: 60000,
  },
});
