#!/usr/bin/env node
/**
 * Live QA for the Codex adapter against the REAL codex CLI (no daemon).
 * Run with: pnpm tsx scripts/qa-codex-adapter.mjs
 *
 * Proves, in order:
 *  1. A read-only stage run succeeds end-to-end (events, sessionId, usage, artifact).
 *  2. The read-only sandbox actually blocks file creation (capability boundary).
 *  3. Resume continues the same thread (validates `exec resume` arg order).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAgentRuntimeAdapter } from '../packages/agents/src/codex.js';

const repo = mkdtempSync(join(tmpdir(), 'codex-qa-'));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
writeFileSync(join(repo, 'hello.txt'), 'hello from the codex QA fixture\n');
writeFileSync(join(repo, 'README.md'), '# codex-qa\nA throwaway fixture repo.\n');
git('init', '-q');
git('add', '-A');
git('-c', 'user.email=qa@local', '-c', 'user.name=qa', 'commit', '-qm', 'fixture');
console.log(`fixture repo: ${repo}`);

const adapter = new CodexAgentRuntimeAdapter({ stallTimeoutMs: 120_000 });

const events = [];
const handlers = {
  onEvent: (e) => events.push(e),
  requestInput: async () => ({ text: '' }),
};

const baseInput = {
  taskId: 'qa_task',
  stage: 'discovery',
  worktreePath: repo,
  contextArtifactIds: [],
  allowedTools: [],
  taskTitle: 'QA smoke',
  rawRequest: 'n/a',
};

function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

// 1. Read-only stage run.
const r1 = await adapter.streamStageAgent(
  {
    ...baseInput,
    promptOverride:
      'List the files in this repo (use shell) and describe the repo in one sentence. ' +
      'End with a fenced ```json block: {"files": [...], "summary": "..."}',
  },
  handlers,
);
check('run 1 succeeded', r1.status === 'succeeded', r1.error ?? '');
check('sessionId captured', typeof r1.sessionId === 'string', r1.sessionId);
check('produced artifact non-empty', (r1.produced[0]?.body ?? '').length > 20);
const cost = events.find((e) => e.type === 'cost');
check('cost event with token usage', Boolean(cost && cost.payload.inputTokens > 0));
check(
  'tool events observed',
  events.some((e) => e.type === 'tool_call'),
);

// 2. Sandbox boundary: read-only run told to write a file.
const r2 = await adapter.streamStageAgent(
  {
    ...baseInput,
    promptOverride:
      'Create a file named PWNED.txt in the current directory containing "x" (try shell). ' +
      'If you cannot, reply exactly CANNOT-WRITE and stop. End with a ```json block {"wrote": true|false}.',
  },
  handlers,
);
const pwned = existsSync(join(repo, 'PWNED.txt'));
check('read-only sandbox blocked the write', !pwned, pwned ? 'PWNED.txt exists!' : 'no file');
console.log(`  (run 2 status=${r2.status}; agent said: ${r2.produced[0]?.body.slice(0, 120)})`);

// 3. Resume the first thread.
const r3 = await adapter.streamStageAgent(
  {
    ...baseInput,
    resume: {
      sessionId: r1.sessionId,
      message: 'One-sentence answer: what was the first file you listed earlier?',
    },
  },
  handlers,
);
check('resume run succeeded', r3.status === 'succeeded', r3.error ?? '');
check('resume stayed on the same thread', r3.sessionId === r1.sessionId, r3.sessionId);

console.log(`\nevents: ${events.length}; final resume answer:\n${r3.produced[0]?.body ?? ''}`);
