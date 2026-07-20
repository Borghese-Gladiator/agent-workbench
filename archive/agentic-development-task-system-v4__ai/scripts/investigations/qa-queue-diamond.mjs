/**
 * QA: multi-task queue diamond DAG against a LIVE daemon (mock runtime).
 *
 * Proves the QueueService scheduler honors the dependency graph
 *
 *        A
 *        |
 *        B
 *       / \
 *      C   D
 *
 * - B does not start until A is `done`.
 * - C and D do not start until B is `done`.
 * - C and D run CONCURRENTLY (unbounded same-project concurrency).
 *
 * It spawns a throwaway daemon, creates the Browser Games project + 4 real
 * Mahjong tasks, enqueues them via the real POST /api/queue surface, then auto-
 * clears every human gate so the mock tasks march to `done` hands-off. While that
 * happens it records, per task, the first time it was observed `running` (an agent
 * run appeared / it left intake) and the time it reached `done`, then asserts the
 * ordering + concurrency invariants and prints a PASS/FAIL verdict.
 *
 * Uses the mock runtime so it is deterministic, fast, and free — the queue
 * scheduling logic is identical regardless of runtime (the driver is the same
 * advanceUntilGate); only the artifact bodies differ.
 *
 *   node scripts/qa-queue-diamond.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4519;
const BASE = `http://127.0.0.1:${PORT}/api`;
const log = (...a) => console.log('[qa]', ...a);

// The Mahjong task suite — real, deliverable units of work that form the diamond.
const ASSETS = resolve(REPO_ROOT, 'stitch_modern_mahjong_suite');
const TASKS = {
  A: {
    title: 'Mahjong engine (pure logic)',
    request:
      'Add packages/engines/mahjong/: a pure, transport-free engine (createGame, addPlayer, ' +
      'publicState, start, applyMove) with tile wall build/shuffle/deal, draw/discard, meld ' +
      'detection (pung/kong/chow), a win check, and turn rotation. Unit-test it in isolation.',
  },
  B: {
    title: 'Mahjong playable in the browser',
    request:
      'Register a mahjong adapter in packages/game-core/src/games.js, add the registry entry ' +
      '(multiplayer: true), and build the board in games/mahjong/ using useGameSocket + <Lobby>. ' +
      'After this a room can be created/joined and a basic game played.',
  },
  C: {
    title: 'Mahjong multiplayer hardening (bots + timeouts)',
    request:
      'Add the optional adapter hooks (botMove, timeoutAction) so a quiet Mahjong room fills ' +
      'empty seats with bots and auto-discards/passes a dark seat on the gateway heartbeat. ' +
      'Ensure spectator publicState leaks no hidden tiles.',
  },
  D: {
    title: 'Mahjong UI polish & redesign',
    request:
      'Visual pass on the Mahjong board using the provided "Zen Mahjong Experience" design ' +
      `assets at ${ASSETS} (DESIGN.md tokens + per-screen mockups main_lobby/room_browser/` +
      'chinese_official_game_board/riichi_game_board + tile references). Translate the tokens ' +
      'into the theme and match the board mockups. IMPORTANT: state in your output that you used ' +
      'the provided stitch_modern_mahjong_suite assets.',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function spawnDaemon(dataDir) {
  const proc = spawn('pnpm', ['--filter', '@workbench/daemon', 'start'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_DATA_DIR: dataDir,
      // Quiet the per-request HTTP logs so the QA's own output is readable.
      WORKBENCH_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`  [daemon] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`  [daemon] ${d}`));
  return proc;
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('daemon never became healthy');
}

/** The gate action that clears a given parked stage, or null if not a gate. */
function gateActionFor(stage) {
  switch (stage) {
    case 'human_brief_approval':
      return 'approve-brief';
    case 'human_plan_approval':
      return 'approve-plan';
    case 'human_review':
      return 'review/complete';
    case 'human_delivery_approval':
      return 'approve-delivery';
    default:
      return null;
  }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-qa-queue-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'wb-qa-mock-repo-'));
  const daemon = spawnDaemon(dataDir);
  const cleanup = () => {
    daemon.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth();
    log('daemon healthy');

    // mock runtime so the run is deterministic + free; repoPath is a placeholder.
    const project = await api('POST', '/projects', {
      name: 'Browser Games (QA queue)',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'mock',
      deliveryPolicy: 'merge_to_master',
    });
    log(`project ${project.id}`);

    // Create the four tasks.
    const ids = {};
    for (const [key, t] of Object.entries(TASKS)) {
      const task = await api('POST', '/tasks', {
        projectId: project.id,
        title: t.title,
        rawRequest: t.request,
      });
      ids[key] = task.id;
      log(`task ${key} = ${task.id}  (${t.title})`);
    }

    // Enqueue the diamond via the REAL queue surface.
    const qA = await api('POST', '/queue', { taskId: ids.A });
    const qB = await api('POST', '/queue', { taskId: ids.B, dependsOn: qA.id });
    const qC = await api('POST', '/queue', { taskId: ids.C, dependsOn: qB.id });
    const qD = await api('POST', '/queue', { taskId: ids.D, dependsOn: qB.id });
    log('enqueued diamond: A <- B <- {C, D}');
    const idToKey = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));

    // Drive loop: clear any parked human gate so the mock tasks march to `done`,
    // until all four queue entries are `done` (or a generous timeout). Ordering is
    // judged AFTER, from the queue entries' own store-stamped startedAt/completedAt
    // timestamps — not from this coarse poll, whose granularity can't separate two
    // transitions that happen in the same interval.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const tasks = await api('GET', '/tasks');
      const mine = tasks.filter((t) => t.id in idToKey);
      for (const t of mine) {
        const action = gateActionFor(t.stage);
        if (action && t.status !== 'done' && t.status !== 'abandoned') {
          // mock raises no questions, so a gate is always clearable.
          await api('POST', `/tasks/${t.id}/${action}`, {}).catch(() => {});
        }
      }
      const q = await api('GET', '/queue');
      if (q.length === 4 && q.every((e) => e.status === 'done')) break;
      await sleep(500);
    }

    // ---- Assertions (from authoritative queue-entry timestamps) ----
    const failures = [];
    const need = (cond, msg) => {
      if (!cond) failures.push(msg);
    };

    const queue = await api('GET', '/queue');
    const byTask = Object.fromEntries(queue.map((e) => [idToKey[e.taskId], e]));
    const ms = (s) => (s ? Date.parse(s) : NaN);
    const startedAt = (k) => ms(byTask[k]?.startedAt); // scheduler marked it running
    const completedAt = (k) => ms(byTask[k]?.completedAt); // task reached done

    log('');
    for (const k of ['A', 'B', 'C', 'D']) {
      const e = byTask[k];
      log(
        `  ${k}: status=${e?.status} started=${e?.startedAt ?? '-'} completed=${e?.completedAt ?? '-'}`,
      );
    }
    log('');

    need(
      queue.length === 4 && queue.every((e) => e.status === 'done'),
      `all 4 queue entries done (got ${queue.map((e) => e.status).join(',')})`,
    );

    // Ordering: a dependent's entry must START (running) no earlier than its
    // predecessor's entry COMPLETED (predecessor task reached done).
    const startsAfter = (dep, pred) =>
      Number.isFinite(startedAt(dep)) &&
      Number.isFinite(completedAt(pred)) &&
      startedAt(dep) >= completedAt(pred);
    need(startsAfter('B', 'A'), 'B started only after A completed');
    need(startsAfter('C', 'B'), 'C started only after B completed');
    need(startsAfter('D', 'B'), 'D started only after B completed');

    // Fan-out concurrency: C and D both depend only on B, so with unbounded
    // concurrency their run intervals [started, completed] overlap.
    {
      const overlap =
        startedAt('C') <= completedAt('D') && startedAt('D') <= completedAt('C');
      need(overlap, 'C and D ran concurrently (overlapping run intervals)');
    }

    log('');
    if (failures.length === 0) {
      log('✅ PASS — queue honored the diamond DAG and ran C+D concurrently');
    } else {
      log('❌ FAIL');
      for (const f of failures) log('   -', f);
    }
    cleanup();
    process.exit(failures.length === 0 ? 0 : 1);
  } catch (err) {
    log('error:', err instanceof Error ? err.message : String(err));
    cleanup();
    process.exit(1);
  }
}

main();
