#!/usr/bin/env node
/**
 * LIVE end-to-end check of per-turn TTFT instrumentation. Spawns the REAL
 * `claude` CLI via the production `ClaudeAgentRuntimeAdapter.streamStageAgent`,
 * persists every streamed event through the REAL `Store` (migrations + receivedAt
 * + spill), then reads the DB back and runs the profiler. Nothing is faked: this
 * is the exact parse->persist->profile path a daemon run uses, minus the HTTP
 * lifecycle wrapper (which is not where the instrumentation lives).
 *
 *   pnpm -C <worktree> exec tsx scripts/live-ttft-run.mjs <repoDir> <dbDir>
 */
import { join } from 'node:path';
import { ClaudeAgentRuntimeAdapter } from '../packages/agents/src/index.ts';
import { profileStage } from '../packages/core/src/index.ts';
import { Store } from '../packages/store/src/index.ts';

// Stage with a permissive-enough policy that Bash tool calls actually RUN
// (discovery is read-only / plan mode and would deny Bash). agent_self_review
// allows Read+Bash under permissionMode 'default'.
const STAGE = 'agent_self_review';

const repoDir = process.argv[2];
const dbDir = process.argv[3];
if (!repoDir || !dbDir) {
  console.error('usage: live-ttft-run.mjs <repoDir> <dbDir>');
  process.exit(1);
}

const store = new Store({
  dbPath: join(dbDir, 'workbench.sqlite'),
  artifactsDir: join(dbDir, 'artifacts'),
});
const project = store.createProject({
  name: 'live',
  repoPath: repoDir,
  defaultBranch: 'main',
  agentRuntime: 'claude',
});
const task = store.createTask({
  projectId: project.id,
  title: 'live ttft probe',
  rawRequest: 'probe',
});
const run = store.createAgentRun({ taskId: task.id, stage: STAGE });

// Persist exactly like the daemon's executor: stamp receivedAt at receive time.
const handlers = {
  onEvent: (ev) => {
    store.appendAgentRunEvent({
      runId: run.id,
      type: ev.type,
      payload: ev.payload,
      receivedAt: new Date().toISOString(),
    });
    if (ev.type === 'turn') {
      const p = ev.payload;
      process.stderr.write(
        `  [turn ${p.index}] ttft=${p.ttftMs}ms input=${p.inputTokens} cacheRead=${p.cacheReadInputTokens} output=${p.outputTokens}\n`,
      );
    }
  },
  requestInput: async () => ({ text: '' }),
};

// A prompt that FORCES several serial tool-using turns (each tool result -> a new
// model turn -> a fresh TTFT measurement), so we see real per-turn gaps.
const promptOverride = [
  'Do these steps ONE AT A TIME, each in its own turn (do not batch tool calls):',
  '1. Run `ls -la` to list the repo.',
  '2. Read notes.md.',
  '3. Run `git log --oneline` to see history.',
  '4. Run `cat notes.md | wc -l` to count its lines.',
  'Then reply with a one-sentence summary of what this repo contains. Do not write any files.',
].join('\n');

const adapter = new ClaudeAgentRuntimeAdapter({ model: 'sonnet', stallTimeoutMs: 5 * 60 * 1000 });

console.error('starting live claude run (this takes a minute or two)...');
const t0 = Date.now();
const result = await adapter.streamStageAgent(
  {
    taskId: task.id,
    stage: STAGE,
    worktreePath: repoDir,
    contextArtifactIds: [],
    // Just Read + Bash so the probe stays serial (no Task subagent fan-out).
    allowedTools: ['Read', 'Bash'],
    taskTitle: task.title,
    rawRequest: task.rawRequest,
    promptOverride,
  },
  handlers,
);
console.error(`run ${result.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

// --- Read back from the DB + profile ---
const events = store.listAgentRunEvents(run.id);
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
const profile = profileStage(STAGE, events);

console.log('# LIVE per-turn TTFT — from the persisted DB\n');
console.log(`run status: ${result.status}`);
console.log(`event counts: ${JSON.stringify(byType)}`);
console.log(
  `received_at populated on every event: ${events.every((e) => e.receivedAt != null) ? 'YES' : 'NO'}\n`,
);

console.log('| turn | ttft | input tok | cache-read | cache-create | output tok |');
console.log('|--:|--:|--:|--:|--:|--:|');
for (const r of profile.turns.rows) {
  const ttft = r.ttftMs == null ? '—' : `${(r.ttftMs / 1000).toFixed(1)}s`;
  console.log(
    `| ${r.index} | ${ttft} | ${r.inputTokens ?? '—'} | ${r.cacheReadInputTokens ?? '—'} | ${r.cacheCreationInputTokens ?? '—'} | ${r.outputTokens ?? '—'} |`,
  );
}
const s = profile.turns.ttft;
console.log(
  `\nttft stats: min=${s.minMs}ms median=${s.medianMs}ms max=${s.maxMs}ms total=${s.totalMs}ms (n=${s.count})`,
);
console.log(`slowest turn: #${profile.turns.slowest?.index} @ ${profile.turns.slowest?.ttftMs}ms`);

// Cross-check: compare a turn's receivedAt vs createdAt to show daemon-persist
// delay is ~0 (validates assumption #2 from the brief — gaps are model-side).
const sample = events.find((e) => e.type === 'turn');
if (sample) {
  const drift = Date.parse(sample.createdAt) - Date.parse(sample.receivedAt);
  console.log(`\nreceivedAt vs createdAt drift on a turn event: ${drift}ms (≈0 => persist is not the bottleneck)`);
}
store.close();
