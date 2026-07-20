#!/usr/bin/env node
/**
 * Split each stage's wall-clock into WORK (real agent/model time) vs WAIT
 * (Playwright pacing + human/recorder gate idle), purely from the two clocks the
 * daemon already persists:
 *
 *   - StageRun  (stage_runs.entered_at -> completed_at)  = stage was "open"
 *   - AgentRun  (agent_runs.started_at -> finished_at)   = actual work
 *
 * WORK  = union of AgentRun intervals CLAMPED to the StageRun window (parallel
 *         runs are unioned, never double-counted; never exceeds Duration).
 * WAIT  = Duration - WORK  (poll ticks in clearGate, human-gate idle, spawn gaps)
 *
 *   node scripts/stage-timing.mjs <db.sqlite> [taskId]
 *
 * If taskId is omitted and the DB holds exactly one task, that task is used.
 * This reads the sqlite file directly (read-only), so it works on finished runs
 * with no daemon listening (e.g. data/<run>/workbench.sqlite).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-sqlite3 is a dependency of @workbench/store, not of this script's dir,
// so resolve it from the store package (same trick as fix-sqlite-binding.mjs).
const repoRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const require = createRequire(join(repoRoot, 'packages/store/package.json'));
const BetterSqlite3 = require('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node scripts/stage-timing.mjs <db.sqlite> [taskId]');
  process.exit(1);
}
let taskId = process.argv[3];

const ms = (n) =>
  n == null
    ? '—'
    : n >= 60000
      ? `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`
      : `${(n / 1000).toFixed(0)}s`;
const pct = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—');
const at = (ts) => (ts ? Date.parse(ts) : null);

const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

if (!taskId) {
  const tasks = db.prepare('SELECT id FROM tasks').all();
  if (tasks.length === 1) taskId = tasks[0].id;
  else {
    console.error(
      `DB has ${tasks.length} tasks; pass one explicitly: ${tasks.map((t) => t.id).join(', ')}`,
    );
    process.exit(1);
  }
}

const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(taskId);
if (!task) {
  console.error(`no task ${taskId} in ${dbPath}`);
  process.exit(1);
}

const stages = db
  .prepare(
    'SELECT id, stage, status, entered_at, completed_at FROM stage_runs WHERE task_id = ? ORDER BY entered_at',
  )
  .all(taskId);
const runs = db
  .prepare('SELECT stage, status, started_at, finished_at FROM agent_runs WHERE task_id = ?')
  .all(taskId);

// Union a set of [start,end] intervals and return total covered ms.
function unionMs(intervals) {
  const iv = intervals.filter((x) => x[0] != null && x[1] != null && x[1] > x[0]);
  if (!iv.length) return 0;
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    const [s, e] = iv[i];
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  return total + (ce - cs);
}

// Classify a stage row so the "what waited" column reads honestly.
function reasonFor(stage, status, durationMs, workMs, waitMs) {
  if (stage.startsWith('human_')) return 'human/recorder gate idle';
  if (durationMs < 500) return 'instant transition';
  if (workMs > 0 && waitMs <= 1000) return 'real agent work';
  if (workMs > 0) return 'agent work + recorder polling';
  return 'recorder polling / gate idle';
}

const rows = [];
let tDur = 0;
let tWork = 0;
for (const sr of stages) {
  const winStart = at(sr.entered_at);
  const winEnd = at(sr.completed_at);
  const durationMs = winStart != null && winEnd != null ? winEnd - winStart : null;
  // Clamp every overlapping agent run to this stage's window, then union.
  const clamped = runs
    .map((r) => {
      const s = at(r.started_at);
      const e = at(r.finished_at) ?? winEnd; // in-progress run: bound at window end
      if (s == null || e == null || winStart == null || winEnd == null) return null;
      if (e <= winStart || s >= winEnd) return null; // no overlap
      return [Math.max(s, winStart), Math.min(e, winEnd)];
    })
    .filter(Boolean);
  const workMs = durationMs == null ? 0 : Math.min(unionMs(clamped), durationMs);
  const waitMs = durationMs == null ? null : Math.max(0, durationMs - workMs);
  tDur += durationMs ?? 0;
  tWork += workMs;
  rows.push({
    stage: sr.stage,
    durationMs,
    workMs,
    waitMs,
    reason: reasonFor(sr.stage, sr.status, durationMs ?? 0, workMs, waitMs ?? 0),
  });
}
const tWait = Math.max(0, tDur - tWork);

console.log(`# Stage timing — ${task.title}`);
console.log(`\nTask \`${taskId}\` · ${dbPath}\n`);
console.log(`| Stage | Duration | Work | Wait | What ate the time |`);
console.log(`|---|--:|--:|--:|---|`);
for (const r of rows) {
  console.log(
    `| ${r.stage} | ${ms(r.durationMs)} | ${ms(r.workMs)} | ${ms(r.waitMs)} | ${r.reason} |`,
  );
}
console.log(
  `| **total** | ${ms(tDur)} | ${ms(tWork)} | ${ms(tWait)} | ${pct(tWait, tDur)} of the run was waiting |`,
);
console.log(
  `\n_Work = union of agent runs clamped to each stage window; Wait = Duration − Work (Playwright poll ticks + human/recorder gate idle + spawn gaps)._`,
);

db.close();
