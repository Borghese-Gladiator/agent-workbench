#!/usr/bin/env node
// Per-phase token-spend report (TASK-79). Reads the live workbench SQLite and prints, per PHASE, the
// cache split (fresh / cache-read / cache-write / output / cost) from model_invocations joined through
// agent_sessions, plus the context-composition split (static instruction/prompt scaffolding vs injected
// task-specific context) from context_composition. Phases are ranked by total input spend so the
// top-offender phases for prompt/context reduction surface first. Read-only — mirrors the query in
// packages/database/src/data-access/observability.ts (getTokenSpendByPhase).
//
// Usage: node scripts/token-spend-by-phase.mjs [path-to-workbench.sqlite] [--task <taskId>]
//        node scripts/token-spend-by-phase.mjs --help
// Defaults to $AWB_DATA_DIR/database/workbench.sqlite (or ~/.agentic-workbench/...); all tasks when
// --task is omitted.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HELP = `token-spend-by-phase — ranked per-phase token spend with cache + static/injected splits (read-only)

Usage:
  node scripts/token-spend-by-phase.mjs [path-to-workbench.sqlite] [--task <taskId>]
  node scripts/token-spend-by-phase.mjs --help

Arguments:
  path-to-workbench.sqlite   SQLite DB (default: $AWB_DATA_DIR/database/workbench.sqlite)
  --task <taskId>            Restrict to one task (default: all tasks)

Columns: fresh (uncached input), cache_read (~0.1x), cache_write (~1.25x), output, cost, then the
context split static (instruction/prompt scaffolding) vs injected (contract/plan/diff/evidence/
findings/repo-map/memory). Phases are ranked by fresh+cache input descending.`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

let taskId;
const taskIdx = argv.indexOf('--task');
if (taskIdx !== -1) {
  taskId = argv[taskIdx + 1];
  argv.splice(taskIdx, 2);
}
const positional = argv.find((a) => !a.startsWith('--'));

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');

const dbPath =
  positional ??
  join(process.env.AWB_DATA_DIR ?? join(homedir(), '.agentic-workbench'), 'database', 'workbench.sqlite');

const db = new Database(dbPath, { readonly: true });

const hasCacheWrite =
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM pragma_table_info('model_invocations') WHERE name='cache_creation_input_tokens'`,
    )
    .get().n > 0;
const cacheWriteExpr = hasCacheWrite ? 'mi.cache_creation_input_tokens' : '0';

const taskFilter = taskId ? 'AND s.task_id = @taskId' : '';

// Cache split per phase (model_invocations → agent_sessions). One row per invocation; a phase with
// several invocations sums.
const invByPhase = db
  .prepare(
    `SELECT s.phase AS phase,
            SUM(mi.input_tokens)                       AS fresh,
            SUM(COALESCE(mi.cached_input_tokens, 0))   AS cache_read,
            SUM(COALESCE(${cacheWriteExpr}, 0))        AS cache_write,
            SUM(mi.output_tokens)                      AS output,
            SUM(COALESCE(mi.cost_usd, 0))              AS cost
       FROM model_invocations mi
       JOIN agent_sessions s ON s.id = mi.agent_session_id
      WHERE 1=1 ${taskFilter}
      GROUP BY s.phase`,
  )
  .all(taskId ? { taskId } : {});

// Static vs injected context per phase (context_composition). Static = instruction_tokens; injected =
// everything task-specific.
const ccTaskFilter = taskId ? 'WHERE cc.task_id = @taskId' : '';
const ccByPhase = db
  .prepare(
    `SELECT cc.phase AS phase,
            SUM(cc.instruction_tokens) AS static_ctx,
            SUM(cc.contract_tokens + cc.plan_tokens + cc.diff_tokens + cc.evidence_tokens
                + cc.findings_tokens + cc.repository_map_tokens + cc.memory_tokens) AS injected_ctx
       FROM context_composition cc
       ${ccTaskFilter}
      GROUP BY cc.phase`,
  )
  .all(taskId ? { taskId } : {});

const byPhase = new Map();
const row = (phase) => {
  let r = byPhase.get(phase);
  if (!r) {
    r = { phase, fresh: 0, cache_read: 0, cache_write: 0, output: 0, cost: 0, static_ctx: 0, injected_ctx: 0 };
    byPhase.set(phase, r);
  }
  return r;
};
for (const r of invByPhase) {
  const t = row(r.phase);
  t.fresh += r.fresh ?? 0;
  t.cache_read += r.cache_read ?? 0;
  t.cache_write += r.cache_write ?? 0;
  t.output += r.output ?? 0;
  t.cost += r.cost ?? 0;
}
for (const r of ccByPhase) {
  const t = row(r.phase);
  t.static_ctx += r.static_ctx ?? 0;
  t.injected_ctx += r.injected_ctx ?? 0;
}

const rows = [...byPhase.values()].sort(
  (a, b) => b.fresh + b.cache_read + b.cache_write - (a.fresh + a.cache_read + a.cache_write),
);

console.log(`DB: ${dbPath}${taskId ? ` (task ${taskId})` : ' (all tasks)'}`);
console.log(`cache_creation column present: ${hasCacheWrite}\n`);
console.log('Per-phase (ranked by input spend):');
console.log('  phase         fresh   cache_read  cache_write   output      cost   static_ctx  injected_ctx');
for (const r of rows) {
  console.log(
    `  ${String(r.phase).padEnd(12)} ${String(r.fresh).padStart(6)} ${String(r.cache_read).padStart(11)} ` +
      `${String(r.cache_write).padStart(12)} ${String(r.output).padStart(8)} ` +
      `${('$' + r.cost.toFixed(4)).padStart(9)} ${String(r.static_ctx).padStart(11)} ${String(r.injected_ctx).padStart(13)}`,
  );
}

const totals = rows.reduce(
  (a, r) => {
    a.fresh += r.fresh;
    a.cache_read += r.cache_read;
    a.cache_write += r.cache_write;
    a.output += r.output;
    a.cost += r.cost;
    a.static_ctx += r.static_ctx;
    a.injected_ctx += r.injected_ctx;
    return a;
  },
  { fresh: 0, cache_read: 0, cache_write: 0, output: 0, cost: 0, static_ctx: 0, injected_ctx: 0 },
);
console.log(
  `\nTOTAL fresh=${totals.fresh} cache_read=${totals.cache_read} cache_write=${totals.cache_write} ` +
    `output=${totals.output} cost=$${totals.cost.toFixed(4)} static_ctx=${totals.static_ctx} injected_ctx=${totals.injected_ctx}`,
);

db.close();
