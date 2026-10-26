#!/usr/bin/env node
// Size-classifier evaluation runner (TASK-62). Read-only: it POSTs to a LOCAL Ollama and reads the
// curated corpus — it never writes the workbench DB. Mirrors scripts/measure-token-cost.mjs in shape
// (self-contained node script, prints a table + rollup). For each model, runs every corpus prompt N
// times and reports accuracy, agreement (self-consistency across the N runs), and a cost-weighted
// error where UNDER-sizing (predicting smaller than expected) is penalized more than over-sizing —
// the same scoring the shadow trace collection records (semanticEvents kind 'size-classifier-shadow').
//
// Usage:
//   node scripts/size-classifier-eval.mjs [--models a,b,c] [--runs N] [--host URL] [--corpus PATH]
//   node scripts/size-classifier-eval.mjs --help
//
// Defaults: models = AWB_SHADOW_CLASSIFIER_MODEL or llama3.2:3b; runs = 3;
//           host = AWB_OLLAMA_HOST or http://127.0.0.1:11434; corpus = docs/task-62-corpus.json.
// Candidate larger models to compare (must be pulled locally first): qwen3:30b, gemma, qwen3-coder:30b.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SIZE_REASON_CODES = [
  'atomic_local_change',
  'obvious_validation',
  'multiple_steps',
  'scope_uncertain',
  'design_choice',
  'cross_system',
  'public_contract',
  'data_migration',
  'security_sensitive',
  'rollout_or_rollback',
];

// Kept in lockstep with packages/planning/src/sizing.ts so the eval exercises the same prompt the
// live shadow classifier uses.
function sizingInstruction(prompt) {
  return [
    'You classify a software-engineering task as S, M, or L by how much up-front planning it warrants.',
    'Judge the WORK the task implies, not how it is phrased.',
    '',
    'S — small:',
    '- Concrete, atomic, locally scoped; one obvious implementation direction.',
    '- No meaningful design decision; no public contract, schema, security, or persistence boundary.',
    '- Validation is obvious and local.',
    '- Examples: fix a typo, tweak copy, add a config value, implement one well-specified helper.',
    '',
    'M — medium (use this when the evidence does not clearly support S or L):',
    '- Bounded work that benefits from an ordered plan: several coordinated edits in one area.',
    '- No architectural, migration, or cross-system decision required.',
    '- Examples: add a field end-to-end within one package, add a filter to a list, refactor one module.',
    '',
    'L — large:',
    '- Planning must resolve design alternatives, substantial uncertainty, or dependent phases.',
    '- Touches public APIs, data schemas, security/authorization, persistence, deployment, migration, or rollback.',
    '- Requires coordination across subsystems or diagnosis spanning multiple components.',
    '- Examples: migrate authentication to OAuth, make the app multi-tenant, change a public data contract.',
    '',
    'Rules of evidence:',
    '- Do NOT use prompt length. A short prompt can describe a huge task; a long, detailed one can describe a tiny change.',
    '- File or package count is evidence, not a rule: a 50-file mechanical rename can be M; a one-line authorization change can be L.',
    '- Weigh uncertainty and blast radius, not verbosity.',
    '',
    `Task:\n${prompt}`,
    '',
    'Respond with ONLY a JSON object as a fenced ```json code block:',
    `{"size": "S" | "M" | "L", "reasonCodes": string[] (subset of: ${SIZE_REASON_CODES.join(', ')})}`,
  ].join('\n');
}

function parseSize(text) {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const block = fenced?.[1] ?? text;
  const m = block.match(/"?size"?\s*[:=]\s*"?([SML])"?/i);
  return m ? m[1].toUpperCase() : undefined;
}

const SIZE_RANK = { S: 0, M: 1, L: 2 };

// Same cost-weighted scoring as workers/temporal-worker/src/activities/classifier-support.ts
// (scoreSizeComparison): under-sizing costs 2 per rank, over-sizing 1 per rank, unavailable = max under.
function scoreSizeComparison(expected, predicted) {
  if (predicted === undefined) {
    return { correct: false, underSized: true, costWeight: 2 * (SIZE_RANK[expected] + 1) };
  }
  const delta = SIZE_RANK[predicted] - SIZE_RANK[expected];
  if (delta === 0) return { correct: true, underSized: false, costWeight: 0 };
  const underSized = delta < 0;
  return { correct: false, underSized, costWeight: underSized ? -delta * 2 : delta };
}

function parseArgs(argv) {
  const opts = { models: null, runs: 3, host: null, corpus: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--models') opts.models = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--runs') opts.runs = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--corpus') opts.corpus = argv[++i];
  }
  return opts;
}

const HELP = `size-classifier-eval — evaluate the local size classifier against a curated corpus (read-only)

Usage:
  node scripts/size-classifier-eval.mjs [options]

Options:
  --models a,b,c   Comma-separated Ollama models to evaluate
                   (default: $AWB_SHADOW_CLASSIFIER_MODEL or llama3.2:3b)
  --runs N         Runs per prompt per model (default: 3)
  --host URL       Ollama host (default: $AWB_OLLAMA_HOST or http://127.0.0.1:11434)
  --corpus PATH    Corpus JSON (default: docs/task-62-corpus.json)
  -h, --help       Show this help and exit

Reports, per model: accuracy (majority vote vs expected), agreement (self-consistency across the N
runs), and cost-weighted error (under-sizing penalized). Candidate larger models to pull and compare:
qwen3:30b, gemma, qwen3-coder:30b.`;

async function classifyOnce(host, model, prompt) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: sizingInstruction(prompt), stream: false, format: 'json' }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return undefined;
    const body = await res.json();
    return parseSize(body.response);
  } catch {
    return undefined;
  }
}

function majority(predictions) {
  const counts = { S: 0, M: 0, L: 0, undefined: 0 };
  for (const p of predictions) counts[p ?? 'undefined']++;
  const ranked = ['S', 'M', 'L'].sort((a, b) => counts[b] - counts[a]);
  return counts[ranked[0]] > 0 ? ranked[0] : undefined;
}

export async function runSizeClassifierEval(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const host = opts.host ?? process.env.AWB_OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const models = opts.models ?? [process.env.AWB_SHADOW_CLASSIFIER_MODEL || 'llama3.2:3b'];
  const corpusPath = opts.corpus ? resolve(opts.corpus) : join(REPO_ROOT, 'docs', 'task-62-corpus.json');

  let corpus;
  try {
    corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read corpus at ${corpusPath}: ${err.message}`);
    return 1;
  }
  const cases = corpus.cases ?? [];
  console.log(`Corpus: ${corpusPath} (${cases.length} cases)`);
  console.log(`Host:   ${host}`);
  console.log(`Runs:   ${opts.runs} per prompt per model\n`);

  const summaries = [];
  for (const model of models) {
    let correct = 0;
    let agreementSum = 0;
    let costWeightedError = 0;
    let underSizedCount = 0;
    let evaluated = 0;

    for (const c of cases) {
      const preds = [];
      for (let r = 0; r < opts.runs; r++) {
        preds.push(await classifyOnce(host, model, c.prompt));
      }
      const voted = majority(preds);
      // Agreement = fraction of runs matching the majority vote (self-consistency).
      const agree = voted ? preds.filter((p) => p === voted).length / preds.length : 0;
      const score = scoreSizeComparison(c.expected, voted);
      if (score.correct) correct++;
      if (score.underSized) underSizedCount++;
      costWeightedError += score.costWeight;
      agreementSum += agree;
      evaluated++;
    }

    const n = Math.max(1, evaluated);
    summaries.push({
      model,
      accuracy: correct / n,
      agreement: agreementSum / n,
      costWeightedError,
      underSizedCount,
    });
  }

  console.log('Per-model:');
  console.log('  model                     accuracy  agreement  cost_err  under_sized');
  for (const s of summaries) {
    console.log(
      `  ${String(s.model).padEnd(24)} ${(s.accuracy * 100).toFixed(1).padStart(7)}% ` +
        `${(s.agreement * 100).toFixed(1).padStart(8)}% ${String(s.costWeightedError).padStart(8)} ` +
        `${String(s.underSizedCount).padStart(11)}`,
    );
  }
  return 0;
}

// Run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  runSizeClassifierEval(process.argv.slice(2)).then((code) => process.exit(code));
}
