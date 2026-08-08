#!/usr/bin/env node
// TASK-46 token-cost measurement. Reads the live workbench SQLite and prints, per AGENT SESSION
// (each phase/role/slice is its own session — phases do NOT share one), the full token breakdown
// (fresh / cache-read / cache-write / output), a per-MODEL rollup, and a recomputed cost that is
// VALIDATED against the SDK-reported cost_usd so a pricing/accounting drift is visible. Read-only.
// Usage: node scripts/measure-token-cost.mjs [path-to-workbench.sqlite]
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

// Published Anthropic per-MTok prices (USD), used ONLY to RECOMPUTE cost as a sanity check against
// the SDK's own cost_usd — which is AUTHORITATIVE (the provider computed it). This table is
// approximate and keyed by a coarse substring of the model id, so newer/variant models (e.g. the
// 1M-context `[1m]` tier, which is priced higher than base Opus) will legitimately diverge and get
// flagged: a large Δ means "update this table for that model", NOT "the SDK cost is wrong". Cache-read
// ≈ 0.1× input, cache-write ≈ 1.25× input. Unknown models fall through to null (recompute skipped).
const PRICES = [
  { match: 'opus', input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 },
  { match: 'sonnet', input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  { match: 'haiku', input: 0.8, cacheRead: 0.08, cacheWrite: 1.0, output: 4 },
];
const priceFor = (model) => PRICES.find((p) => model.toLowerCase().includes(p.match)) ?? null;

const recomputeCost = (model, r) => {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (r.fresh_input * p.input +
      r.cache_read * p.cacheRead +
      r.cache_write * p.cacheWrite +
      r.output * p.output) /
    1_000_000
  );
};

const hasCacheWrite =
  db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('model_invocations') WHERE name='cache_creation_input_tokens'`).get()
    .n > 0;
const cacheWriteExpr = hasCacheWrite ? 'mi.cache_creation_input_tokens' : '0';

// One row per session (a session has 0 or 1 model_invocations rows — the SDK reports usage once, on
// the final result). LEFT JOIN so a session that recorded no usage (e.g. a mock run) still appears.
const sessions = db
  .prepare(
    `SELECT s.id AS session_id, s.phase AS phase, COALESCE(mi.model, s.model, '(none)') AS model,
            COALESCE(mi.input_tokens, 0)            AS fresh_input,
            COALESCE(mi.cached_input_tokens, 0)     AS cache_read,
            COALESCE(${cacheWriteExpr}, 0)          AS cache_write,
            COALESCE(mi.output_tokens, 0)           AS output,
            mi.cost_usd                             AS cost_usd
       FROM agent_sessions s
       LEFT JOIN model_invocations mi ON mi.agent_session_id = s.id
      ORDER BY s.started_at`,
  )
  .all();

console.log(`DB: ${dbPath}`);
console.log(`cache_creation column present: ${hasCacheWrite}\n`);

// ---- Per-session table (the useful granularity: each phase/slice differs) --------------------------
console.log('Per-session:');
console.log(
  '  phase       model                fresh   cache_read  cache_write  output   sdk_cost   calc_cost  Δ',
);
let driftFlagged = false;
for (const r of sessions) {
  const calc = recomputeCost(r.model, r);
  const sdk = r.cost_usd;
  // Flag when our recomputed cost and the SDK's disagree by >5% (and >$0.001) — a pricing-table or
  // accounting drift we'd want to know about, not silently trust.
  let delta = '';
  if (calc !== null && sdk != null && sdk > 0) {
    const diff = Math.abs(calc - sdk) / sdk;
    if (diff > 0.05 && Math.abs(calc - sdk) > 0.001) {
      delta = `⚠ ${(diff * 100).toFixed(0)}%`;
      driftFlagged = true;
    } else {
      delta = 'ok';
    }
  } else if (calc === null) {
    delta = '(unpriced model)';
  }
  console.log(
    `  ${String(r.phase).padEnd(10)} ${String(r.model).padEnd(20)} ` +
      `${String(r.fresh_input).padStart(6)} ${String(r.cache_read).padStart(11)} ` +
      `${String(r.cache_write).padStart(12)} ${String(r.output).padStart(7)} ` +
      `${sdk == null ? '—' : ('$' + sdk.toFixed(4)).padStart(9)} ` +
      `${calc == null ? '—' : ('$' + calc.toFixed(4)).padStart(9)}  ${delta}`,
  );
}

// ---- Per-model rollup ------------------------------------------------------------------------------
const byModel = new Map();
for (const r of sessions) {
  const m = byModel.get(r.model) ?? { fresh: 0, read: 0, write: 0, out: 0, sdk: 0, calc: 0, calcKnown: true };
  m.fresh += r.fresh_input;
  m.read += r.cache_read;
  m.write += r.cache_write;
  m.out += r.output;
  m.sdk += r.cost_usd ?? 0;
  const c = recomputeCost(r.model, r);
  if (c === null) m.calcKnown = false;
  else m.calc += c;
  byModel.set(r.model, m);
}
console.log('\nPer-model:');
for (const [model, m] of byModel) {
  console.log(
    `  ${model.padEnd(20)} fresh=${m.fresh} cache_read=${m.read} cache_write=${m.write} out=${m.out} ` +
      `sdk_cost=$${m.sdk.toFixed(4)} calc_cost=${m.calcKnown ? '$' + m.calc.toFixed(4) : '(unpriced)'}`,
  );
}

// ---- Totals + validation ---------------------------------------------------------------------------
const t = sessions.reduce(
  (a, r) => {
    a.fresh += r.fresh_input;
    a.read += r.cache_read;
    a.write += r.cache_write;
    a.out += r.output;
    a.sdk += r.cost_usd ?? 0;
    const c = recomputeCost(r.model, r);
    if (c === null) a.calcKnown = false;
    else a.calc += c;
    return a;
  },
  { fresh: 0, read: 0, write: 0, out: 0, sdk: 0, calc: 0, calcKnown: true },
);
console.log(
  `\nTOTAL fresh=${t.fresh} cache_read=${t.read} cache_write=${t.write} output=${t.out} ` +
    `sdk_cost=$${t.sdk.toFixed(2)} calc_cost=${t.calcKnown ? '$' + t.calc.toFixed(2) : '(some unpriced)'}`,
);
if (t.calcKnown && t.sdk > 0) {
  const diff = Math.abs(t.calc - t.sdk) / t.sdk;
  console.log(
    `Cost validation: recomputed is ${(diff * 100).toFixed(1)}% off the SDK total ` +
      `(${diff <= 0.05 ? 'within 5% — consistent' : 'OVER 5% — investigate pricing table or accounting'}).`,
  );
}
if (driftFlagged) {
  console.log('Note: ⚠ rows above diverge >5% between recomputed and SDK cost — check PRICES vs the model actually used.');
}

db.close();
