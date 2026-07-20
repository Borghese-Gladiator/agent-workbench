#!/usr/bin/env tsx
/**
 * Verify the project-memory SUMMARIZER (#2 quality check).
 *
 * Reuses the EXACT production pieces — `memorySummaryPrompt` + the real
 * `ClaudeAgentRuntimeAdapter.runStageAgent` one-shot via `promptOverride` — so
 * this judges the same output `closeout()` would append, not a parallel path.
 * It reads a finished task's durable artifacts straight from the workbench DB.
 *
 *   pnpm verify:memory <taskId>           # dry: print the assembled prompt only
 *   pnpm verify:memory <taskId> --live    # run real claude, print the entry
 *
 * No taskId → lists tasks that have enough durable artifacts to summarize.
 *
 * What to judge in the --live output (the bar the prompt asks for):
 *   - 1–6 bullets, each "<decision> — because <reason>"
 *   - DURABLE decisions (architecture/impl/naming/convention), NOT a task recap
 *   - concrete (names a file/module/pattern), not generic
 *   - no preamble / heading / closing remarks
 */
import { resolve } from 'node:path';
import { memorySummaryPrompt, PROJECT_MEMORY_STAGE_LABEL } from '../apps/daemon/src/service.js';
import { ClaudeAgentRuntimeAdapter, stripStructuredJson } from '../packages/agents/src/index.js';
import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '../packages/core/src/index.js';
import { Store } from '../packages/store/src/index.js';

// The four kinds closeout distills, in the order it reads them. Mirrors
// LifecycleService.memorySourceKinds (private), kept in sync by hand.
const SOURCE_KINDS: ArtifactKind[] = [
  'task_brief',
  'execution_plan',
  'self_review',
  'delivery_package',
];

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? resolve(process.env.WORKBENCH_DATA_DIR)
  : resolve(REPO_ROOT, 'data');

const args = process.argv.slice(2);
const live = args.includes('--live');
const taskId = args.find((a) => !a.startsWith('--'));

const store = new Store({
  dbPath: resolve(DATA_DIR, 'workbench.sqlite'),
  artifactsDir: resolve(DATA_DIR, 'artifacts'),
});

function listCandidates(): void {
  // Tasks that have at least 2 of the 4 durable kinds — enough to summarize.
  const tasks = store.listTasks();
  console.log('\nTasks with durable artifacts to summarize:\n');
  for (const t of tasks) {
    const arts = store.listArtifacts(t.id);
    const kinds = SOURCE_KINDS.filter((k) => arts.some((a) => a.kind === k));
    if (kinds.length >= 2) {
      console.log(`  ${t.id}  [${kinds.join(', ')}]`);
      console.log(`    ${t.title}\n`);
    }
  }
  console.log('Run:  pnpm verify:memory <taskId> [--live]\n');
}

async function run(id: string): Promise<void> {
  const task = store.getTask(id);
  if (!task) {
    console.error(`Task not found: ${id}`);
    process.exit(1);
  }
  const arts = store.listArtifacts(id);
  const sources: { label: string; body: string }[] = [];
  for (const kind of SOURCE_KINDS) {
    const latest = arts.filter((a) => a.kind === kind).at(-1);
    if (!latest) continue;
    const body = store.readArtifactBody(latest.id);
    if (body?.trim()) sources.push({ label: ARTIFACT_KIND_LABELS[kind] ?? kind, body });
  }
  if (sources.length === 0) {
    console.error(`Task ${id} has no durable artifacts to summarize.`);
    process.exit(1);
  }

  const prompt = memorySummaryPrompt(task.title, sources);
  console.log(`\n=== Task: ${task.title}`);
  console.log(`=== Durable sources: ${sources.map((s) => s.label).join(', ')}\n`);

  if (!live) {
    console.log('--- ASSEMBLED PROMPT (dry run; pass --live to run claude) ---\n');
    console.log(prompt);
    return;
  }

  console.log('--- Running claude (one-shot, same path as closeout) ---\n');
  const adapter = new ClaudeAgentRuntimeAdapter({
    bin: process.env.WORKBENCH_CLAUDE_BIN || 'claude',
    model: process.env.WORKBENCH_CLAUDE_MODEL || undefined,
  });
  const result = await adapter.runStageAgent({
    taskId: task.id,
    stage: PROJECT_MEMORY_STAGE_LABEL as never,
    worktreePath: REPO_ROOT,
    contextArtifactIds: [],
    allowedTools: [],
    taskTitle: task.title,
    rawRequest: task.rawRequest,
    promptOverride: prompt,
  });
  const raw = result.produced[0]?.body?.trim() || result.transcript.body.trim();
  const body = stripStructuredJson(raw); // same cleanup closeout applies before append
  console.log('--- MEMORY ENTRY (this is what closeout would append) ---\n');
  console.log(`## ${new Date().toISOString().slice(0, 10)} — ${task.title}\n`);
  console.log(body || '(empty — summarizer produced nothing)');
  console.log(`\n--- status: ${result.status}${result.error ? ` (${result.error})` : ''} ---`);
}

try {
  if (!taskId) listCandidates();
  else await run(taskId);
} finally {
  store.close();
}
