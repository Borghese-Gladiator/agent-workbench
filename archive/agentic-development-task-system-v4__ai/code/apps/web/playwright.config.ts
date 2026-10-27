import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * E2E config for the UI-redesign walkthrough. Boots an ISOLATED daemon (own
 * port + temp data dir) and the Vite dev server, then records a video + trace
 * of the full 10-step walkthrough so there is a durable, replayable artifact.
 *
 * Run: `pnpm --filter @workbench/web e2e`
 * Video/trace/report land in apps/web/e2e-artifacts/.
 *
 * Temp dirs are created HERE (config load is the earliest hook, before the
 * webServer launches) so the daemon's env picks up the real paths. Teardown
 * removes them.
 */
const PORT = process.env.E2E_DAEMON_PORT ?? '4319';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '5319';

// Isolated, throwaway data dir + a real git repo (worktree creation needs one).
const dataDir = mkdtempSync(join(tmpdir(), 'wb-e2e-data-'));
const repoDir = mkdtempSync(join(tmpdir(), 'wb-e2e-repo-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git(
  '-c',
  'user.email=e2e@x.com',
  '-c',
  'user.name=e2e',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'init',
);

// Hand the paths to the spec + teardown.
writeFileSync(
  join(here, 'e2e', '.env-paths.json'),
  JSON.stringify({ dataDir, repoDir, daemonPort: PORT }),
);

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'e2e-artifacts/report', open: 'never' }]],
  outputDir: 'e2e-artifacts/test-results',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    video: 'on',
    trace: 'on',
    viewport: { width: 1280, height: 1100 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @workbench/daemon dev',
      cwd: '../..',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WORKBENCH_PORT: PORT, WORKBENCH_DATA_DIR: dataDir },
    },
    {
      command: 'pnpm --filter @workbench/web dev',
      cwd: '../..',
      url: `http://localhost:${WEB_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WORKBENCH_PORT: PORT, VITE_PORT: WEB_PORT },
    },
  ],
});
