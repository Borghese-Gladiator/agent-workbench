import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Install the same process-level safety net the daemon uses at boot, so
    // tests run under production's contract. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
