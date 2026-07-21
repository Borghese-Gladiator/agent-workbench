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

/**
 * Probes a URL until it responds. Tries both the given host and its localhost counterpart, because
 * dev servers (Vite in particular) bind to `localhost` which may resolve to IPv6 `::1` only — so a
 * probe hardcoded to `127.0.0.1` never connects even though the server is up. Returns the URL that
 * actually responded (the caller drives the browser at that one), or undefined on timeout.
 */
async function waitForServer(url: string, timeoutMs: number): Promise<string | undefined> {
  const candidates = [url, ...localhostVariants(url)];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate);
        if (res.ok || res.status < 500) return candidate;
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/** The same URL with the host swapped between `localhost` and `127.0.0.1` (dedup handled by caller). */
function localhostVariants(url: string): string[] {
  if (url.includes('localhost')) return [url.replace('localhost', '127.0.0.1')];
  if (url.includes('127.0.0.1')) return [url.replace('127.0.0.1', 'localhost')];
  return [];
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
    const readyUrl = await waitForServer(input.baseUrl, input.readinessTimeoutMs ?? 30_000);
    if (!readyUrl) {
      throw new Error(`dev server did not become ready at ${input.baseUrl} within the timeout`);
    }
    // Drive the browser at the host that actually responded (may differ from the requested one when
    // the server bound only localhost/IPv6 or only 127.0.0.1).
    const scenario = readyUrl === input.baseUrl ? input.scenario : { ...input.scenario, baseUrl: readyUrl };
    return await runBrowserQa(scenario, input.context, input.artifactStore);
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
