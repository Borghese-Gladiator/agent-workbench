import { existsSync, mkdirSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * DEMO recorder config — records the Agent Workbench WEB UI while the lifecycle
 * runs against a live daemon, producing a screen-capture .webm of the product
 * itself (board → gates → live agent terminal → diff → PR).
 *
 * Unlike apps/web/playwright.config.ts (which BOOTS its own daemon+Vite to test
 * the workbench) this config boots NOTHING — `scripts/drive.mjs` already runs the
 * isolated daemon + the web dev server and hands us their addresses + the task
 * to watch via env:
 *
 *   DEMO_WEB_URL     where the workbench UI serves, e.g. http://localhost:5318
 *   DEMO_API_BASE    the daemon API base, e.g. http://127.0.0.1:4602/api
 *   DEMO_TASK_ID     the task to open and drive through the gates
 *   DEMO_OUTPUT_DIR  where the recording lands (gitignored demo-artifacts/<scenario>)
 *   DEMO_PACE_MS     optional read-beat between UI steps (default 1500)
 *
 * Run (via the orchestrator, not by hand):
 *   pnpm --filter @workbench/web exec playwright test -c demo-harness/playwright.config.ts
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`demo recorder: missing required env ${name}`);
  return v;
}

const WEB_URL = required('DEMO_WEB_URL');
const OUTPUT_DIR = process.env.DEMO_OUTPUT_DIR ?? 'demo-artifacts/run';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

export default defineConfig({
  testDir: '.',
  testMatch: 'record.spec.ts',
  // A real claude build can take many minutes; the recorder watches the whole run.
  timeout: 120 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `${OUTPUT_DIR}/test-results`,
  use: {
    baseURL: WEB_URL,
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
    trace: 'on',
    // Generous per-action timeout: the UI must wait on real agent stages between gates.
    actionTimeout: 40 * 60_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
