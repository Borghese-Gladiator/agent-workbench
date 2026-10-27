/**
 * driver-core — shared plumbing for the single lifecycle driver (scripts/drive.mjs).
 *
 * Everything here is scenario- and mode-agnostic: argv parsing, the tolerant
 * daemon API client (with the dropped-socket sentinel), gate firing, stage/state
 * polling, health waits, and git seed-repo helpers. The three former drivers
 * (demo.mjs / live-e2e.mjs / proof-run.mjs) each reimplemented these; now they
 * share one copy.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------

/** `--flag value` -> value (or undefined). */
export function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** boolean `--flag` presence. */
export function has(name) {
  return process.argv.includes(`--${name}`);
}

/** Expand a leading `~` to the user's home dir. */
export function expandHome(p) {
  return p?.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// ---------------------------------------------------------------------------
// tolerant API client
// ---------------------------------------------------------------------------

/**
 * Build an API client bound to a daemon base URL. A gate POST blocks server-side
 * for the ENTIRE downstream stage chain (real multi-minute claude runs), which
 * exceeds Node's default server.requestTimeout, so the server drops the socket
 * and the fetch throws. That's EXPECTED — surface it as a `dropped` sentinel and
 * let the caller poll task state instead of relying on the response.
 */
export function makeApi(base) {
  return async function api(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      return { status: 0, body: null, dropped: true, error: String(err?.cause ?? err) };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON / removed routes */
    }
    return { status: res.status, body: json };
  };
}

/** Fire a long gate POST without awaiting its (possibly never-returning) body. */
export function fireGate(base, tid, gate) {
  fetch(`${base}/tasks/${tid}/${gate}`, { method: 'POST' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// MCP-backed API client (dogfoods @workbench/mcp as a real driver)
// ---------------------------------------------------------------------------

/** Map a daemon REST path the demo uses to an MCP tool call. Returns parsed JSON. */
async function callForPath(mcp, method, path, body) {
  // Reads/writes the demo actually performs — everything else falls through to
  // the raw daemon (caller keeps a tolerant fetch path for those).
  const tasksId = path.match(/^\/tasks\/([^/]+)$/)?.[1];
  if (method === 'GET' && tasksId) return mcpTool(mcp, 'get_task', { taskId: tasksId });

  const artId = path.match(/^\/artifacts\/([^/]+)$/)?.[1];
  if (method === 'GET' && artId) return mcpTool(mcp, 'get_artifact', { artifactId: artId });

  const diffId = path.match(/^\/tasks\/([^/]+)\/worktree\/diff$/)?.[1];
  if (method === 'GET' && diffId) return mcpTool(mcp, 'worktree_diff', { taskId: diffId });

  const run = path.match(/^\/tasks\/([^/]+)\/agent\/runs\/([^/]+)$/);
  if (method === 'GET' && run) return mcpTool(mcp, 'get_run', { taskId: run[1], runId: run[2] });

  if (method === 'POST' && path === '/projects') return mcpTool(mcp, 'create_project', body);
  if (method === 'POST' && path === '/tasks') return mcpTool(mcp, 'create_task', body);

  return undefined; // not an MCP-routed path
}

/** Invoke an MCP tool and unwrap its single text-content result to JSON (or throw). */
export async function mcpTool(mcp, name, args) {
  const res = await mcp.callTool({ name, arguments: args ?? {} });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

/**
 * An `api(method, path, body)` with the SAME {status, body, dropped} contract as
 * makeApi — but reads and create_* go through the @workbench/mcp stdio server
 * (pointed at this daemon), proving the MCP works as a driver. Gate POSTs are
 * intentionally NOT routed here: fireGate fires a non-awaited long POST (the
 * daemon blocks for the whole downstream chain), which an awaited tool call
 * can't model. `health` and anything unmapped degrade to the tolerant fetch.
 *
 * Returns { api, mcp, close }. `repoRoot` locates the workspace so we can spawn
 * `pnpm --filter @workbench/mcp dev`. Falls back to a raw fetch client (and
 * `mcp: null`) if the MCP can't be started, so the demo never hard-fails on it.
 */
export async function makeMcpApi(base, repoRoot) {
  const raw = makeApi(base);
  const workbenchUrl = base.replace(/\/api\/?$/, '');

  let Client;
  let StdioClientTransport;
  let mcp = null;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['--filter', '@workbench/mcp', 'dev'],
      env: { ...process.env, WORKBENCH_URL: workbenchUrl },
      cwd: repoRoot,
    });
    mcp = new Client({ name: 'workbench-driver', version: '0.1.0' });
    await mcp.connect(transport);
  } catch (err) {
    mcp = null;
    return {
      api: raw,
      mcp: null,
      close: async () => {},
      mcpError: String(err?.message ?? err),
    };
  }

  const api = async (method, path, body) => {
    try {
      const routed = await callForPath(mcp, method, path, body);
      if (routed !== undefined) return { status: 200, body: routed };
    } catch (err) {
      // Surface daemon-side failures with the same shape the raw client uses.
      return { status: 400, body: null, error: String(err?.message ?? err) };
    }
    return raw(method, path, body); // health + anything unmapped
  };

  return {
    api,
    mcp,
    close: async () => {
      try {
        await mcp.close();
      } catch {
        /* already gone */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: wait for the in-flight run to finish (near-zero lag, vs fixed polling)
// ---------------------------------------------------------------------------

/**
 * Resolve when the task's currently active agent run reaches a terminal state,
 * using the daemon's per-run SSE stream — which the daemon ends() exactly when
 * the run succeeds/fails. This is the heaviest wait in a real run (the multi-
 * minute implementation/QA stage), so reacting to the stream closing instead of
 * polling every few seconds removes that whole lag.
 *
 * Returns:
 *   'finished'  the active run's SSE stream closed (run hit terminal)
 *   'idle'      there was no active run to wait on (caller should just read state)
 *   'fallback'  SSE was unavailable / errored — caller MUST fall back to polling
 *
 * Never throws: any failure degrades to 'fallback' so the driver keeps working
 * even if SSE is flaky (the daemon drops sockets under load — see ECONNRESET).
 */
export async function waitForRunToFinish(base, tid, { timeoutMs = 30 * 60_000 } = {}) {
  let runId;
  try {
    const res = await fetch(`${base}/tasks/${tid}/agent/runs/active`);
    runId = (await res.json())?.run?.id;
  } catch {
    return 'fallback';
  }
  if (!runId) return 'idle';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/tasks/${tid}/agent/runs/${runId}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return 'fallback';
    // Drain the stream to its end. The daemon res.end()s on the run's terminal
    // event, so the reader simply runs dry — we don't need to parse events.
    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return 'finished';
  } catch {
    // Aborted (timeout) or socket dropped mid-stream — let the caller poll.
    return 'fallback';
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Adaptive backoff: poll fast at first, then ease off toward a cap. A stage that
 * settles in a second or two is noticed in ~minMs (instead of a fixed 3–4s tick);
 * a stage that runs for minutes settles onto cheap capped polls so we don't hammer
 * the daemon (which drops sockets under load). Default 400ms → 4s, factor 1.6.
 */
export function backoff({ minMs = 400, maxMs = 4_000, factor = 1.6 } = {}) {
  let next = minMs;
  return {
    /** Sleep the current interval, then grow it toward maxMs. */
    async wait() {
      await sleep(next);
      next = Math.min(maxMs, Math.round(next * factor));
    },
    /** Reset to minMs (call when state changes, so the next transition is caught fast). */
    reset() {
      next = minMs;
    },
  };
}

/**
 * Poll GET /tasks/:id until it REACHES targetStage, or settles short of it.
 *
 * If `opts.base` is given, the between-poll wait prefers the SSE run-complete
 * signal: when the task is mid-run we block on the active run's stream closing
 * (reacting the instant that run ends) instead of sleeping a fixed interval, then
 * re-poll. The stage chain may span several runs, so this loops naturally. SSE
 * gaps ('fallback'/'idle') degrade to adaptive backoff — correctness is identical,
 * only latency differs.
 */
export async function waitUntilStage(api, tid, targetStage, label, maxMs, log, opts = {}) {
  const { base } = opts;
  const deadline = Date.now() + maxMs;
  const b = backoff();
  let last = '';
  while (Date.now() < deadline) {
    const { body } = await api('GET', `/tasks/${tid}`);
    const stage = body?.task?.stage;
    const status = body?.task?.status;
    const cur = `${stage}/${status}`;
    if (cur !== last) {
      log?.(`  [${label}] ${cur}`);
      last = cur;
      b.reset(); // just transitioned — poll fast for the next change
    }
    if (stage === targetStage) return body;
    if (status === 'blocked' || status === 'failed' || status === 'awaiting_input') return body;

    // Mid-run: wait on the run finishing (SSE) rather than a blind sleep. Any
    // non-'finished' outcome means no live stream to ride — fall back to backoff.
    let waited = false;
    if (base && (status === 'active' || status === 'running')) {
      const remaining = deadline - Date.now();
      const r = await waitForRunToFinish(base, tid, { timeoutMs: Math.max(0, remaining) });
      if (r === 'finished') {
        b.reset();
        waited = true;
      }
    }
    if (!waited) await b.wait();
  }
  throw new Error(`timed out waiting to reach ${targetStage} (stuck at ${last})`);
}

/** Poll GET /tasks/:id until predicate(task) holds or the budget runs out. */
export async function pollTask(api, tid, predicate, { timeoutMs = 20 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const b = backoff();
  let last = null;
  let lastStage = '';
  while (Date.now() < deadline) {
    const r = await api('GET', `/tasks/${tid}`);
    const task = r.body?.task;
    if (task) {
      last = task;
      if (predicate(task)) return task;
      const cur = `${task.stage}/${task.status}`;
      if (cur !== lastStage) {
        lastStage = cur;
        b.reset(); // state moved — catch the next move quickly
      }
    }
    await b.wait();
  }
  return last;
}

/** Wait until a spawned daemon/web process answers `url` (or its own /health). */
export async function waitForHealth(proc, label, check, { tries = 300, intervalMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null) throw new Error(`${label} exited early (${proc.exitCode})`);
    try {
      if (await check()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} did not become healthy`);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

/**
 * Create a fresh, committed git repo on `main` at `target`, wiping any existing
 * dir unless `keep` is set. Optionally seeds a `check.sh` validation script
 * (proof scenario) whose exit code is controlled by `failCheck`.
 */
export function makeFreshRepo(
  target,
  { keep = false, label = 'workbench', seedCheck = false, failCheck = false } = {},
) {
  if (keep) {
    if (!existsSync(target)) throw new Error(`keep set but ${target} does not exist`);
    return target;
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', `${label}@example.com`);
  git(target, 'config', 'user.name', label);
  writeFileSync(join(target, 'README.md'), `# ${label}\n`);
  if (seedCheck) {
    // A trivially-passing validation command set proves the real runner ran.
    writeFileSync(
      join(target, 'check.sh'),
      `#!/bin/sh\necho "checks ran"\nexit ${failCheck ? 1 : 0}\n`,
    );
  }
  git(target, 'add', '.');
  git(target, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return target;
}
