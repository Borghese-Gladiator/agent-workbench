import { spawn } from 'node:child_process';
import { killProcessTree } from '@awb/execution';
import { runBrowserQa, type BrowserQaScenario } from '@awb/qa';
import type { ArtifactStore } from '@awb/evidence';
import type { QaEvidenceContext } from '@awb/qa';

export interface BrowserQaViaServerInput {
  /** Shell command that starts the dev server (e.g. `npm run dev`), run in the worktree. */
  startCommand: string;
  worktreePath: string;
  /** URL the server is expected to serve once ready (e.g. http://127.0.0.1:5173). */
  baseUrl: string;
  scenario: BrowserQaScenario;
  context: QaEvidenceContext;
  artifactStore: ArtifactStore;
  readinessTimeoutMs?: number;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Starts the game's dev server, waits for it to serve, runs real browser QA (real chromium, real
 * video + trace via runBrowserQa) against it, then tears the server's process tree down (Fix 5).
 * The dev server is a long-running process, so it is spawned directly (runCommand only resolves on
 * exit). Returns the runBrowserQa result. Throws if the server never becomes ready — the caller
 * treats that as a QA failure rather than silently passing.
 */
export async function runBrowserQaViaServer(input: BrowserQaViaServerInput): Promise<ReturnType<typeof runBrowserQa>> {
  const child = spawn(input.startCommand, {
    cwd: input.worktreePath,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });

  try {
    const ready = await waitForUrl(input.baseUrl, input.readinessTimeoutMs ?? 30_000);
    if (!ready) {
      throw new Error(`dev server did not become ready at ${input.baseUrl} within the timeout`);
    }
    return await runBrowserQa(input.scenario, input.context, input.artifactStore);
  } finally {
    if (child.pid !== undefined) {
      try {
        killProcessTree(child.pid, 'SIGKILL');
      } catch {
        // best-effort teardown
      }
    }
  }
}
