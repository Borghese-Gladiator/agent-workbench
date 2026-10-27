import { spawn } from 'node:child_process';
import { killProcessTree } from '@awb/execution';
import { runBrowserQa, type BrowserQaScenario } from '@awb/qa';
import type { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
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
 * The readiness window for a spawned dev server. A cold Vite/uvicorn start (first-run transform,
 * dependency pre-bundle) can take well over the old 30s on a large app, so the default is generous
 * and overridable via `AWB_QA_READINESS_TIMEOUT_MS` (TASK-66). Never below 30s.
 */
function resolveReadinessTimeoutMs(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const raw = process.env.AWB_QA_READINESS_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 30_000) return parsed;
  return 90_000;
}

/**
 * A bounded capture of a child process's stdout/stderr. Dev-server output is unbounded (Vite prints
 * on every HMR tick), so keep only the last `maxBytes` — enough to show why a start failed without
 * pinning an entire session's logs in memory. `exitInfo` records an early exit (a crash before the
 * server ever served) so a caller can distinguish "server died" from "server slow".
 */
interface ServerLog {
  text(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function attachServerLog(child: ReturnType<typeof spawn>, maxBytes = 64 * 1024): ServerLog {
  const chunks: Buffer[] = [];
  let size = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const append = (buf: Buffer): void => {
    chunks.push(buf);
    size += buf.length;
    while (size > maxBytes && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) size -= dropped.length;
    }
  };

  child.stdout?.on('data', (d: Buffer) => append(Buffer.from(d)));
  child.stderr?.on('data', (d: Buffer) => append(Buffer.from(d)));
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });

  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    exitInfo: () => exit,
  };
}

/**
 * Probes a URL until it responds, OR the server process exits first (a crash). Tries both the given
 * host and its localhost counterpart, because dev servers (Vite in particular) bind to `localhost`
 * which may resolve to IPv6 `::1` only — so a probe hardcoded to `127.0.0.1` never connects even
 * though the server is up. Returns the URL that actually responded, or undefined on timeout / early
 * exit (the caller then surfaces the captured server log).
 */
async function waitForServer(
  url: string,
  timeoutMs: number,
  serverExited: () => boolean,
): Promise<string | undefined> {
  const candidates = [url, ...localhostVariants(url)];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited()) return undefined;
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
 * Starts the app's dev server, waits for it to serve, runs real browser QA (real chromium, real
 * video + trace via runBrowserQa) against it, then tears the server's process tree down.
 *
 * Startup is made legible (TASK-66): the server's stdout/stderr are captured (never `stdio:'ignore'`)
 * and, on a failed start, both persisted as a `command-log` artifact AND folded into the thrown error
 * so a failed boot shows *why* rather than a bare "did not become ready" string. An early process
 * exit is detected so a crash isn't misreported as a slow start. The dev server is long-running, so it
 * is spawned directly (runCommand only resolves on exit). Throws if the server never becomes ready —
 * the caller treats that as a QA failure rather than silently passing.
 */
export async function runBrowserQaViaServer(input: BrowserQaViaServerInput): Promise<ReturnType<typeof runBrowserQa>> {
  const child = spawn(input.startCommand, {
    cwd: input.worktreePath,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = attachServerLog(child);

  const persistServerLog = async (): Promise<ArtifactRecord | undefined> => {
    const body = log.text();
    if (body.trim().length === 0) return undefined;
    try {
      return await input.artifactStore.put({
        source: Buffer.from(body, 'utf8'),
        mediaType: 'text/plain',
        kind: 'command-log',
        retention: 'permanent',
        taskId: input.context.taskId,
        runId: input.context.runId,
        phaseAttemptId: input.context.phaseAttemptId,
        candidateSha: input.context.candidateSha,
      });
    } catch {
      return undefined;
    }
  };

  try {
    const timeoutMs = resolveReadinessTimeoutMs(input.readinessTimeoutMs);
    const readyUrl = await waitForServer(input.baseUrl, timeoutMs, () => log.exitInfo() !== undefined);
    if (!readyUrl) {
      await persistServerLog();
      const exit = log.exitInfo();
      const why = exit
        ? `dev server exited (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}) before serving ${input.baseUrl}`
        : `dev server did not become ready at ${input.baseUrl} within ${timeoutMs}ms`;
      const tail = log.text().slice(-4000);
      throw new Error(`${why}. Command: \`${input.startCommand}\`\n--- server output ---\n${tail || '(no output captured)'}`);
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
