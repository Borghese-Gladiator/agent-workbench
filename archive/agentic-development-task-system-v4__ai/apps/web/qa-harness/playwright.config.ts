import { existsSync, mkdirSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Shared QA harness for the workbench's `verification` stage.
 *
 * Unlike `apps/web/playwright.config.ts` (which boots THIS app's daemon + Vite to
 * test the workbench itself), this config tests an ARBITRARY target project the
 * workbench built into. Playwright + the browser live here in the workbench, so
 * no install/config is scaffolded into the target — the target stays clean.
 *
 * The QA agent writes only a `*.spec.ts` walkthrough; the daemon points this
 * config at the target via env:
 *
 *   QA_TARGET_DIR    absolute path to the target worktree (where the app lives)
 *   QA_DEV_COMMAND   the project's devCommand — booted as the webServer black box
 *                    (may build-then-run); the app must end up served at QA_BASE_URL
 *   QA_BASE_URL      where the app serves, e.g. http://localhost:5173
 *   QA_SPEC_DIR      dir holding the agent-authored spec(s) (workbench-side scratch)
 *   QA_OUTPUT_DIR    where videos/traces are written (workbench-side; captured durably)
 *
 * Run: `pnpm --filter @workbench/web exec playwright test -c qa-harness/playwright.config.ts`
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`QA harness: missing required env ${name}`);
  return v;
}

const TARGET_DIR = required('QA_TARGET_DIR');
const DEV_COMMAND = required('QA_DEV_COMMAND');
const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:5173';
const SPEC_DIR = required('QA_SPEC_DIR');
const OUTPUT_DIR = process.env.QA_OUTPUT_DIR ?? `${SPEC_DIR}/output`;

if (!existsSync(SPEC_DIR)) mkdirSync(SPEC_DIR, { recursive: true });
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

export default defineConfig({
  testDir: SPEC_DIR,
  fullyParallel: false,
  workers: 1,
  // One E2E run at a time — concurrent browser sessions corrupt shared state.
  reporter: [['list'], ['json', { outputFile: `${OUTPUT_DIR}/results.json` }]],
  outputDir: `${OUTPUT_DIR}/test-results`,
  use: {
    baseURL: BASE_URL,
    video: 'on',
    trace: 'on',
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Always boot the target via its devCommand (build-then-run included) and wait
  // until it serves at QA_BASE_URL. This is the app-under-test's lifecycle black box.
  webServer: {
    command: DEV_COMMAND,
    cwd: TARGET_DIR,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
