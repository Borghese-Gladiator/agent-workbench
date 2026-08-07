#!/usr/bin/env node
// TASK-46 token-cost measurement. Reads the live workbench SQLite and prints per-phase token/cost
// breakdown + the context_composition preamble estimate, so the "% preamble vs % in-session context"
// question can be answered from real runs. Read-only. Usage:
//   node scripts/measure-token-cost.mjs [path-to-workbench.sqlite]
// Defaults to $AWB_DATA_DIR/database/workbench.sqlite (or ~/.agentic-workbench/...).
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// better-sqlite3 is a workspace dependency of @awb/database; resolve it from there so this script
// runs from the repo root without its own install.
const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const Database = require('better-sqlite3');

const dbPath =
  process.argv[2] ??
  join(process.env.AWB_DATA_DIR ?? join(homedir(), '.agentic-workbench'), 'database', 'workbench.sqlite');

const db = new Database(dbPath, { readonly: true });

const hasCacheWrite =
  db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('model_invocations') WHERE name='cache_creation_input_tokens'`).get()
    .n > 0;

const cacheWriteCol = hasCacheWrite ? 'SUM(mi.cache_creation_input_tokens) AS cached_write,' : '0 AS cached_write,';

const byPhase = db
  .prepare(
    `SELECT s.phase,
            COUNT(DISTINCT s.id)          AS sessions,
            COUNT(mi.id)                  AS invocations,
            SUM(mi.input_tokens)          AS fresh_input,
            SUM(mi.cached_input_tokens)   AS cached_read,
            ${cacheWriteCol}
            SUM(mi.output_tokens)         AS output,
            ROUND(SUM(mi.cost_usd), 4)    AS cost_usd
       FROM model_invocations mi
       JOIN agent_sessions s ON s.id = mi.agent_session_id
      GROUP BY s.phase
      ORDER BY cost_usd DESC`,
  )
  .all();

const events = db
  .prepare(`SELECT phase, COUNT(*) AS events FROM semantic_events GROUP BY phase`)
  .all();
const eventsByPhase = Object.fromEntries(events.map((e) => [e.phase, e.events]));

const cc = db
  .prepare(
    `SELECT phase,
            SUM(contract_tokens + plan_tokens + diff_tokens + evidence_tokens +
                findings_tokens + repository_map_tokens + memory_tokens + instruction_tokens) AS preamble_est
       FROM context_composition
      GROUP BY phase`,
  )
  .all();
const preambleByPhase = Object.fromEntries(cc.map((r) => [r.phase, r.preamble_est]));

console.log(`DB: ${dbPath}`);
console.log(`cache_creation column present: ${hasCacheWrite}\n`);
console.log('Per-phase token cost (all runs in this DB):');
for (const r of byPhase) {
  const ratio = r.fresh_input ? (r.cached_read / r.fresh_input).toFixed(0) : 'n/a';
  console.log(
    `  ${r.phase.padEnd(10)} sessions=${r.sessions} events≈${eventsByPhase[r.phase] ?? 0} ` +
      `fresh_in=${r.fresh_input} cached_read=${r.cached_read} cached_write=${r.cached_write} ` +
      `out=${r.output} cost=$${r.cost_usd} cached:fresh=${ratio}x ` +
      `preamble_est=${preambleByPhase[r.phase] ?? 0}`,
  );
}

const totals = db
  .prepare(
    `SELECT SUM(input_tokens) AS fresh, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS output,
            ROUND(SUM(cost_usd), 2) AS cost FROM model_invocations`,
  )
  .get();
console.log(
  `\nTOTAL fresh_input=${totals.fresh} cached_read=${totals.cached} output=${totals.output} cost=$${totals.cost}`,
);
console.log(
  `Preamble estimate is the sum of our assembled contextPayload buckets — compare it to cached_read to see\n` +
    `how much of what the model re-reads each turn is our injected preamble vs. accumulated in-session context.`,
);

db.close();
