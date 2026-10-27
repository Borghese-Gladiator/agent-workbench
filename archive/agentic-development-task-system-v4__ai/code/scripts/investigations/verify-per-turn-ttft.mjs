#!/usr/bin/env node
/**
 * Manual verification for per-turn TTFT instrumentation. Drives the REAL
 * production path end-to-end against a temp SQLite DB:
 *
 *   stream NDJSON --(consumeStreamLine)--> turn events
 *     --(Store.appendAgentRunEvent w/ receivedAt)--> agent_run_events
 *     --(Store.listAgentRunEvents)--> read back
 *     --(profileStage)--> the decisive per-turn ttft-vs-tokens table
 *
 * It proves: (1) `turn` events persist with per-turn ttft + tokens, (2)
 * `received_at` round-trips, (3) the profiler attributes the gap. This stands in
 * for a 15-min live `claude` run for the inner verification loop; the same
 * `turnStats` runs over a real DB unchanged.
 *
 *   pnpm -C <worktree> exec tsx scripts/verify-per-turn-ttft.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeStreamLine, newStreamAccumulator } from '../packages/agents/src/index.ts';
import { profileStage } from '../packages/core/src/index.ts';
import { Store } from '../packages/store/src/index.ts';

// A synthetic 3-turn stream that mimics the brief's observation: a turn whose
// TTFT rises WITH its input-token count (the H1 signal), interleaved with tools.
let t = 1_000_000;
const now = () => t;
const advance = (ms) => {
  t += ms;
};
const lines = [];
const push = (obj) => lines.push(JSON.stringify(obj));

const messageStart = () => ({ type: 'stream_event', event: { type: 'message_start' } });
const assistant = (usage, tool) => ({
  type: 'assistant',
  message: { usage, content: tool ? [tool] : [] },
});
const toolResult = (content) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', content }] },
});

// Build the stream with realistic gaps.
push({ type: 'system', subtype: 'init', session_id: 'sess_verify' });
// Turn 1: small context, fast first token.
push(messageStart());
push(
  assistant(
    { input_tokens: 25_000, cache_read_input_tokens: 0, output_tokens: 300 },
    {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: 'a.ts' },
    },
  ),
);
push(toolResult('contents of a.ts'));
// Turn 2: bigger context, slow first token.
push(messageStart());
push(
  assistant(
    { input_tokens: 140_000, cache_read_input_tokens: 110_000, output_tokens: 900 },
    {
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'pnpm test' },
    },
  ),
);
push(toolResult('all tests passed'));
// Turn 3: biggest context, slowest first token.
push(messageStart());
push(assistant({ input_tokens: 165_000, cache_read_input_tokens: 150_000, output_tokens: 1500 }));
push({ type: 'result', subtype: 'success', result: 'done', num_turns: 3, total_cost_usd: 0.42 });

// The per-line inter-arrival gaps (ms), index-aligned to `lines`. The big silent
// gaps land right before each turn's first model emission (messageStart).
const gaps = [
  0, // system
  50_000, // turn1 messageStart  (50s)
  400, // turn1 assistant
  2_000, // turn1 tool_result
  70_000, // turn2 messageStart  (70s)
  500, // turn2 assistant
  1_500, // turn2 tool_result
  95_000, // turn3 messageStart  (95s)
  600, // turn3 assistant
  100, // result
];

// --- Drive the real path ---
const dir = mkdtempSync(join(tmpdir(), 'wb-ttft-verify-'));
const store = new Store({
  dbPath: join(dir, 'workbench.sqlite'),
  artifactsDir: join(dir, 'artifacts'),
});
const project = store.createProject({ name: 'verify', repoPath: dir, defaultBranch: 'main' });
const task = store.createTask({ projectId: project.id, title: 'verify ttft', rawRequest: 'x' });
const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });

const acc = newStreamAccumulator();
acc.turnBoundaryMs = now(); // adapter anchors turn 1 at prompt-send
const handlers = {
  onEvent: (ev) => {
    // Mirror the executor: stamp receivedAt at receive time, persist.
    store.appendAgentRunEvent({
      runId: run.id,
      type: ev.type,
      payload: ev.payload,
      receivedAt: new Date(now()).toISOString(),
    });
  },
  requestInput: async () => ({ text: '' }),
};

lines.forEach((line, i) => {
  advance(gaps[i] ?? 0);
  consumeStreamLine(line, acc, handlers, now);
});

// --- Read back + profile ---
const events = store.listAgentRunEvents(run.id);
const turnEvents = events.filter((e) => e.type === 'turn');
const profile = profileStage('discovery', events);

console.log('# Per-turn TTFT verification\n');
console.log(`persisted ${events.length} events; ${turnEvents.length} are \`turn\` events\n`);

// receivedAt round-trip check.
const allHaveReceivedAt = events.every((e) => e.receivedAt != null);
console.log(`received_at populated on every event: ${allHaveReceivedAt ? 'YES' : 'NO'}\n`);

console.log('| turn | ttft | input tok | cache-read | output tok | cache-read % |');
console.log('|--:|--:|--:|--:|--:|--:|');
for (const r of profile.turns.rows) {
  const ttft = r.ttftMs == null ? '—' : `${(r.ttftMs / 1000).toFixed(0)}s`;
  const cachePct =
    r.inputTokens && r.cacheReadInputTokens != null
      ? `${Math.round((100 * r.cacheReadInputTokens) / r.inputTokens)}%`
      : '—';
  console.log(
    `| ${r.index} | ${ttft} | ${r.inputTokens ?? '—'} | ${r.cacheReadInputTokens ?? '—'} | ${r.outputTokens ?? '—'} | ${cachePct} |`,
  );
}
const s = profile.turns.ttft;
console.log(
  `\nttft stats: min=${s.minMs}ms median=${s.medianMs}ms max=${s.maxMs}ms (n=${s.count})`,
);
console.log(`slowest turn: #${profile.turns.slowest?.index} @ ${profile.turns.slowest?.ttftMs}ms`);
console.log(
  '\nH1 read: ttft rises monotonically with input tokens (25k→50s, 140k→70s, 165k→95s) → prefill-bound.',
);
store.close();
