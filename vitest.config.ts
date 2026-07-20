import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'workers/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'archive/**'],
    testTimeout: 30000,
  },
});
