import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CliInvocation,
  CliResult,
  CliStreamResult,
  McpServerDef,
  StreamAccumulator,
} from './claude.js';
import { consumeStreamLine, newStreamAccumulator } from './claude.js';
import {
  AGENT_STAGES,
  type AgentRunInput,
  ASK_STAGES,
  ASK_TOOL,
  allowedToolsForStage,
  bufferingHandlers,
  ClaudeAgentRuntimeAdapter,
  claudeStagePrompt,
  contextKindsForStage,
  createAgentAdapter,
  disallowedToolsForStage,
  Effort,
  isGenericTitle,
  MockAgentRuntimeAdapter,
  mapPolicyToClaude,
  policyForStage,
  runtimeProfile,
  STAGE_TO_ARTIFACT,
  type StreamEvent,
  type StreamHandlers,
  stageWantsProjectMemory,
  stripStructuredJson,
} from './index.js';

const baseInput = (stage: string): AgentRunInput => ({
  taskId: 'task_1',
  stage: stage as AgentRunInput['stage'],
  worktreePath: '/tmp/wt/task_1',
  contextArtifactIds: ['art_a', 'art_b'],
  allowedTools: ['read_file', 'write_file'],
  taskTitle: 'Add dark mode',
  rawRequest: 'Users want a dark mode toggle.',
});

describe('MockAgentRuntimeAdapter', () => {
  const adapter = new MockAgentRuntimeAdapter();

  it.each(AGENT_STAGES)('produces the expected artifact for stage %s', async (stage) => {
    const result = await adapter.runStageAgent(baseInput(stage));

    expect(result.status).toBe('succeeded');
    expect(result.error).toBeUndefined();
    expect(result.produced).toHaveLength(1);
    expect(result.produced[0]!.kind).toBe(STAGE_TO_ARTIFACT[stage]);
    expect(result.produced[0]!.body.length).toBeGreaterThan(0);

    // Transcript is a log artifact mentioning the run inputs.
    expect(result.transcript.kind).toBe('log');
    expect(result.transcript.body).toContain('read_file, write_file');
    expect(result.transcript.body).toContain('art_a, art_b');
    expect(result.transcript.body).toContain('/tmp/wt/task_1');
  });

  it('fails for an unsupported stage but still returns a transcript', async () => {
    const result = await adapter.runStageAgent(baseInput('implementation'));

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/does not support/);
    expect(result.produced).toHaveLength(0);
    expect(result.transcript.kind).toBe('log');
  });
});

describe('per-stage tool policy', () => {
  it('hard-denies filesystem mutation for code-reading read-only stages', () => {
    // Discovery + planning (one stage) READS the codebase but cannot mutate it.
    for (const stage of ['discovery']) {
      const allowed = allowedToolsForStage(stage);
      expect(allowed).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
      expect(allowed).not.toContain('Edit');

      // The real boundary: Bash/Edit/Write are hard-denied.
      const denied = disallowedToolsForStage(stage);
      expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit']));
      expect(mapPolicyToClaude(policyForStage(stage)).permissionMode).toBe('plan');
    }
  });

  it('task_brief does EXTERNAL research only — code reading is hard-denied', () => {
    const allowed = allowedToolsForStage('task_brief');
    // It may load the ticket/issue from the web or Linear/Jira...
    expect(allowed).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__linear-server', 'mcp__atlassian']),
    );
    // ...but it must NOT explore source — that is Discovery's job.
    expect(allowed).not.toContain('Read');
    const denied = disallowedToolsForStage('task_brief');
    expect(denied).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    // Mutation/escape still hard-denied.
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit']));
    expect(mapPolicyToClaude(policyForStage('task_brief')).permissionMode).toBe('plan');
  });

  it('hard-denies orchestration/escape tools for read-only stages and the default policy', () => {
    // Live-run finding: discovery probed Task/Agent/ToolSearch/Skill/ExitPlanMode
    // and used Monitor as a shell escape. Read-only stages must deny them all.
    const escapes = [
      'Task',
      'Agent',
      'Skill',
      'Monitor',
      'ToolSearch',
      'ExitPlanMode',
      'KillShell',
    ];
    for (const stage of ['task_brief', 'discovery', 'unknown_stage']) {
      expect(disallowedToolsForStage(stage)).toEqual(expect.arrayContaining(escapes));
    }
    // QA/review stages dispatch their skills via Task — it must stay available.
    for (const stage of ['feature_e2e', 'agent_self_review']) {
      const denied = disallowedToolsForStage(stage);
      expect(denied).not.toContain('Task');
      expect(allowedToolsForStage(stage)).toContain('Task');
    }
  });

  it('verification allows Write (to author the E2E spec) but still denies Edit', () => {
    // The QA agent writes ONE spec into the workbench-side QA_SPEC_DIR. Write is
    // allowed for that; Edit/NotebookEdit stay denied so it cannot alter the
    // target's source — QA proves the change, it must not change it.
    expect(allowedToolsForStage('feature_e2e')).toContain('Write');
    expect(disallowedToolsForStage('feature_e2e')).toEqual(
      expect.arrayContaining(['Edit', 'NotebookEdit']),
    );
    expect(disallowedToolsForStage('feature_e2e')).not.toContain('Write');
  });

  it('allows read/edit/bash for implementation with nothing denied', () => {
    expect(allowedToolsForStage('implementation')).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']),
    );
    expect(disallowedToolsForStage('implementation')).toHaveLength(0);
    expect(mapPolicyToClaude(policyForStage('implementation')).permissionMode).toBe('acceptEdits');
  });

  it('allows bash for self-review inspection but hard-denies edit/write', () => {
    expect(allowedToolsForStage('agent_self_review')).toEqual(
      expect.arrayContaining(['Read', 'Bash']),
    );
    const denied = disallowedToolsForStage('agent_self_review');
    expect(denied).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(denied).not.toContain('Bash');
  });

  it('allows bash for delivery_prep (git diff) but hard-denies file mutation', () => {
    // delivery_prep reads the diff to write the PR/commit body; it must NOT edit
    // source, so Edit/Write are hard-denied even though Bash (git) is allowed.
    expect(allowedToolsForStage('delivery_prep')).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash']),
    );
    const denied = disallowedToolsForStage('delivery_prep');
    expect(denied).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(denied).not.toContain('Bash');
  });

  it('project_memory_summary gets NO tools and default mode (not plan)', () => {
    // The closeout summarizer explores nothing — no tools. And it must NOT run in
    // `plan` mode (the DEFAULT_TOOL_POLICY fallback), which makes the model narrate
    // a preamble before answering; `default` removes that structurally.
    expect(allowedToolsForStage('project_memory_summary')).toEqual([]);
    expect(mapPolicyToClaude(policyForStage('project_memory_summary')).permissionMode).toBe(
      'default',
    );
    // Mutation/escape still hard-denied (it has no business doing either).
    expect(disallowedToolsForStage('project_memory_summary')).toEqual(
      expect.arrayContaining(['Bash', 'Edit', 'Write']),
    );
  });

  it('createAgentAdapter returns the right adapter type', () => {
    expect(createAgentAdapter('mock')).toBeInstanceOf(MockAgentRuntimeAdapter);
    expect(createAgentAdapter('claude')).toBeInstanceOf(ClaudeAgentRuntimeAdapter);
  });
});

describe('Claude profile per-stage model routing', () => {
  const claude = runtimeProfile('claude');
  it.each([
    ['task_brief', 'opus'],
    ['feature_e2e', 'haiku'],
    ['agent_self_review', 'opus'],
    ['delivery_prep', 'opus'],
    ['project_memory_summary', 'opus'],
  ])('routes %s to %s', (stage, model) => {
    expect(claude.modelForStage(stage, {})).toBe(model);
  });

  it('leaves the expensive reasoning stages on the adapter default (undefined)', () => {
    // discovery (discovery+planning) and implementation (the mutating agent) keep
    // the default model — routing them cheap would degrade the work that matters.
    expect(claude.modelForStage('discovery', {})).toBeUndefined();
    expect(claude.modelForStage('implementation', {})).toBeUndefined();
  });

  it('returns undefined for an unknown stage', () => {
    expect(claude.modelForStage('not_a_stage', {})).toBeUndefined();
  });

  it('a project-configured model overrides the per-stage alias for every stage', () => {
    expect(claude.modelForStage('discovery', { model: 'sonnet' })).toBe('sonnet');
    expect(claude.modelForStage('feature_e2e', { model: 'sonnet' })).toBe('sonnet');
  });
});

describe('Claude profile per-stage effort routing', () => {
  const claude = runtimeProfile('claude');
  it.each([
    ['task_brief', Effort.Low],
    ['agent_self_review', Effort.High],
    ['delivery_prep', Effort.Low],
    ['project_memory_summary', Effort.High],
  ])('routes %s to %s effort', (stage, effort) => {
    expect(claude.effortForStage(stage)).toBe(effort);
  });

  it('leaves stages without an effort override undefined (CLI/model default)', () => {
    // feature_e2e carries a model (haiku) but no effort; the reasoning stages
    // carry neither.
    for (const stage of ['feature_e2e', 'discovery', 'implementation', 'not_a_stage']) {
      expect(claude.effortForStage(stage)).toBeUndefined();
    }
  });
});

describe('Pi profile model/effort routing', () => {
  const pi = runtimeProfile('pi');

  it('defaults build/reasoning stages to the capable coder model', () => {
    // No project config -> the proven per-stage defaults apply.
    expect(pi.modelForStage('discovery', {})).toBe('ollama/qwen3-coder:30b');
    expect(pi.modelForStage('implementation', {})).toBe('ollama/qwen3-coder:30b');
    expect(pi.modelForStage('task_brief', {})).toBe('ollama/qwen3-coder:30b');
    expect(pi.modelForStage('delivery_prep', {})).toBe('ollama/qwen3-coder:30b');
    // A stage with no explicit entry still gets the capable default.
    expect(pi.modelForStage('not_a_stage', {})).toBe('ollama/qwen3-coder:30b');
  });

  it('defaults the heavy review stages to the fast model (the 30B coder stalls there)', () => {
    expect(pi.modelForStage('feature_e2e', {})).toBe('ollama/llama3.2:latest');
    expect(pi.modelForStage('agent_self_review', {})).toBe('ollama/llama3.2:latest');
  });

  it('a project-configured model overrides the per-stage defaults for every stage', () => {
    const cfg = { model: 'ollama/custom-model:latest' };
    expect(pi.modelForStage('discovery', cfg)).toBe('ollama/custom-model:latest');
    expect(pi.modelForStage('feature_e2e', cfg)).toBe('ollama/custom-model:latest');
  });

  it('has no per-stage effort', () => {
    expect(pi.effortForStage('task_brief')).toBeUndefined();
    expect(pi.effortForStage('feature_e2e')).toBeUndefined();
  });
});

describe('deliberate-question (ask) capability', () => {
  it('auto-approves the ask tool only for ask-enabled stages', () => {
    expect(ASK_STAGES.has('discovery')).toBe(true);
    expect(allowedToolsForStage('discovery')).toContain(ASK_TOOL);

    // Stages not opted in must NOT advertise the ask tool.
    for (const stage of ['task_brief', 'agent_self_review', 'implementation']) {
      expect(ASK_STAGES.has(stage as never)).toBe(false);
      expect(allowedToolsForStage(stage)).not.toContain(ASK_TOOL);
    }
  });

  const promptInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
    taskId: 'task_1',
    stage: 'discovery',
    worktreePath: '/tmp/wt/task_1',
    contextArtifactIds: [],
    allowedTools: allowedToolsForStage('discovery'),
    taskTitle: 'Add dark mode',
    rawRequest: 'Users want a dark mode toggle.',
    ...over,
  });

  it('includes the ask instruction only when the stage is ask-enabled AND gated', () => {
    const gate = { daemonUrl: 'http://127.0.0.1:1', runId: 'run_1' };

    // ask-enabled + gated → clause present
    expect(claudeStagePrompt(promptInput({ gate }))).toContain('workbench_ask');

    // ask-enabled but no gate (one-shot) → no clause (tool isn't wired)
    expect(claudeStagePrompt(promptInput({ gate: undefined }))).not.toContain('workbench_ask');

    // gated but NOT ask-enabled → no clause
    expect(claudeStagePrompt(promptInput({ stage: 'feature_e2e', gate }))).not.toContain(
      'workbench_ask',
    );
  });

  it('asks the operator only under the strict 4-point test, not for style/naming defaults', () => {
    const gate = { daemonUrl: 'http://127.0.0.1:1', runId: 'run_1' };
    const prompt = claudeStagePrompt(promptInput({ gate }));
    // The conjunctive gate ("ALL of these are true") + the explicit don't-ask list.
    expect(prompt).toMatch(/Ask ONLY when ALL of these are true/i);
    expect(prompt).toMatch(/at least two genuinely viable choices/i);
    expect(prompt).toMatch(/Do NOT ask about naming, file placement, style/i);
  });
});

describe('isGenericTitle', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['ab', true],
    ['task', true],
    ['Linear Ticket', true],
    ['ticket', true],
    ['Untitled', true],
    ['New task', true],
    ['https://linear.app/klaviyo/issue/CORE-242', true],
    ['CORE-242', true],
    ['Add dark mode toggle', false],
    ['Fix CORE-242: campaigns CSV export', false],
    ['Refactor the auth middleware', false],
  ])('isGenericTitle(%j) === %s', (title, expected) => {
    expect(isGenericTitle(title)).toBe(expected);
  });
});

describe('claudeStagePrompt — derive title', () => {
  it('adds the naming clause only when deriveTitle is set', () => {
    const withDerive = claudeStagePrompt({ ...baseInput('task_brief'), deriveTitle: true });
    expect(withDerive).toContain('## Naming this task');
    expect(withDerive).toContain('`title` key');

    expect(claudeStagePrompt(baseInput('task_brief'))).not.toContain('## Naming this task');
  });
});

describe('claudeStagePrompt — reviewer feedback', () => {
  it('includes a feedback section only when reviewerFeedback is set', () => {
    const withFeedback = claudeStagePrompt({
      ...baseInput('task_brief'),
      reviewerFeedback: 'too vague',
    });
    expect(withFeedback).toContain('Reviewer feedback to address');
    expect(withFeedback).toContain('too vague');

    const without = claudeStagePrompt(baseInput('task_brief'));
    expect(without).not.toContain('Reviewer feedback to address');

    // Blank feedback is treated as absent.
    expect(
      claudeStagePrompt({ ...baseInput('task_brief'), reviewerFeedback: '   ' }),
    ).not.toContain('Reviewer feedback to address');
  });
});

describe('claudeStagePrompt — project memory', () => {
  it('renders a ## Project memory section only when projectMemory is set', () => {
    const withMem = claudeStagePrompt({
      ...baseInput('discovery'),
      projectMemory: '## 2026-06-01 — Prior task\n- chose Kysely — because typed SQL',
    });
    expect(withMem).toContain('## Project memory');
    expect(withMem).toContain('chose Kysely — because typed SQL');
    // It is distinct from the current task's own prior context.
    expect(withMem).toContain('EARLIER COMPLETED tasks');

    expect(claudeStagePrompt(baseInput('discovery'))).not.toContain('## Project memory');
    // Blank/whitespace memory is treated as absent.
    expect(claudeStagePrompt({ ...baseInput('discovery'), projectMemory: '   ' })).not.toContain(
      '## Project memory',
    );
  });
});

describe('stageWantsProjectMemory', () => {
  it('is true for the combined discovery stage, false elsewhere', () => {
    expect(stageWantsProjectMemory('discovery')).toBe(true);
    expect(stageWantsProjectMemory('task_brief')).toBe(false);
    expect(stageWantsProjectMemory('implementation')).toBe(false);
    expect(stageWantsProjectMemory('feature_e2e')).toBe(false);
    expect(stageWantsProjectMemory('agent_self_review')).toBe(false);
  });
});

describe('claudeStagePrompt — delivery_prep', () => {
  it('renders the delivery-prep instruction and inlines the injected skill', () => {
    const prompt = claudeStagePrompt({
      ...baseInput('delivery_prep'),
      skillText: 'Active delivery policy: `create_pr`.\n\nPR DESCRIPTION RULES',
    });
    // Non-mock stage instruction is resolved (not the "Run the stage" fallback).
    expect(prompt).toContain('Delivery preparation');
    expect(prompt).not.toContain('Run the "delivery_prep" stage.');
    // The policy-named skill body is inlined under ## Skill.
    expect(prompt).toContain('## Skill');
    expect(prompt).toContain('Active delivery policy: `create_pr`.');
    expect(prompt).toContain('PR DESCRIPTION RULES');
  });
});

describe('claudeStagePrompt — scoped self-review re-review', () => {
  it('frames agent_self_review feedback as a scoped re-review, not a generic redo', () => {
    const prompt = claudeStagePrompt({
      ...baseInput('agent_self_review'),
      reviewerFeedback: '### Prior self-review findings\n- Blocking: null deref in foo()',
    });
    // Scoped re-review framing — NOT the generic "address this feedback" block.
    expect(prompt).toContain('Re-review (scoped');
    expect(prompt).toContain('this is NOT a fresh review');
    expect(prompt).toMatch(/only new \*blocking\* regressions/i);
    expect(prompt).not.toContain('Reviewer feedback to address');
    // The prior findings packet is carried through verbatim.
    expect(prompt).toContain('null deref in foo()');
  });

  it('keeps the generic feedback framing for non-review stages', () => {
    const prompt = claudeStagePrompt({
      ...baseInput('implementation'),
      reviewerFeedback: 'fix the race',
    });
    expect(prompt).toContain('Reviewer feedback to address');
    expect(prompt).not.toContain('Re-review (scoped');
  });
});

describe('claudeStagePrompt — acceptance-criteria contract', () => {
  it('task_brief requires the Acceptance Criteria table, scoped to real goals (not test cases)', () => {
    const prompt = claudeStagePrompt(baseInput('task_brief'));
    expect(prompt).toContain('Acceptance Criteria');
    expect(prompt).toContain('ID | Requirement | Risk (H/M/L)');
    expect(prompt).toMatch(/stable ID/i);
    // One row per real GOAL, not per test case — and assumptions are conditional.
    expect(prompt).toMatch(/per real, user-visible GOAL/i);
    expect(prompt).toMatch(/2–3 goals/);
    expect(prompt).toMatch(
      /Open assumptions.*ONLY where|ONLY where the request was actually ambiguous/i,
    );
  });

  it('discovery binds each criterion ID to a validation method', () => {
    const prompt = claudeStagePrompt(baseInput('discovery'));
    expect(prompt).toContain('Validation by criterion');
    expect(prompt).toContain('Criterion ID | Validation method | Test type | Automated?');
    expect(prompt).toMatch(/one row per\s+Acceptance Criteria ID/i);
  });

  it('verification gates each scenario on "would this have failed before?" + maps criteria', () => {
    const prompt = claudeStagePrompt(baseInput('feature_e2e'));
    expect(prompt).toMatch(/would this have failed before this change\?/i);
    expect(prompt).toContain('Criterion coverage');
    expect(prompt).toMatch(/each Acceptance Criteria ID to the scenario/i);
  });
});

describe('claudeStagePrompt — implementation instruction', () => {
  it('gives implementation a real "apply the plan / edit files" job, not the generic fallback', () => {
    const prompt = claudeStagePrompt(baseInput('implementation'));
    // Concrete implementation instruction, not "Run the implementation stage."
    expect(prompt).toContain('apply the approved Execution Plan');
    expect(prompt).toMatch(/creating and editing files/i);
    expect(prompt).not.toContain('Run the "implementation" stage.');
  });

  it('tells implementation NOT to re-survey the repo (apply the plan directly)', () => {
    const prompt = claudeStagePrompt(baseInput('implementation'));
    // The missing-working-memory fix: the plan is authoritative; don't re-explore.
    expect(prompt).toMatch(/do not re-survey the repo/i);
    expect(prompt).toMatch(/authoritative/i);
  });
});

describe('claudeStagePrompt — discovery instruction', () => {
  it('requires a concrete per-file change list applyable without re-reading', () => {
    const prompt = claudeStagePrompt(baseInput('discovery'));
    // The plan must carry concrete per-file briefs (the handoff fix).
    expect(prompt).toMatch(/## Changes/);
    expect(prompt).toMatch(/create\|modify\|delete/);
    expect(prompt).toMatch(/without opening the file first/i);
  });
});

describe('claudeStagePrompt — self-review instruction', () => {
  it('scopes self-review to the diff + criteria and defers how-to-run to the skill', () => {
    const prompt = claudeStagePrompt(baseInput('agent_self_review'));
    expect(prompt).toMatch(/`git diff`/);
    expect(prompt).toMatch(/Acceptance Criteria/i);
    // The instruction itself does NOT mandate a subagent — the skill preamble decides
    // (inline for one reviewer, dispatch for the enterprise fan-out).
    expect(prompt).toMatch(/dictated by the injected skill/i);
  });
});

describe('claudeStagePrompt — prior context (inlined bodies)', () => {
  it('renders FULL bodies under "## Prior context", labelled by kind', () => {
    const prompt = claudeStagePrompt({
      ...baseInput('discovery'),
      contextArtifacts: [
        { kind: 'task_brief', title: 'Task Brief', body: 'AC1: toggle persists.' },
        { kind: 'discovery', title: 'Discovery', body: 'theme.ts owns the palette.' },
      ],
    });
    expect(prompt).toContain('## Prior context');
    expect(prompt).toContain('### Task Brief — Task Brief');
    expect(prompt).toContain('AC1: toggle persists.');
    expect(prompt).toContain('### Discovery — Discovery');
    expect(prompt).toContain('theme.ts owns the palette.');
    // Do NOT re-derive what these cover.
    expect(prompt).toMatch(/do NOT re-derive/i);
  });

  it('omits the section entirely when no bodies are threaded', () => {
    const prompt = claudeStagePrompt(baseInput('task_brief'));
    expect(prompt).not.toContain('## Prior context');
    // The ids still appear as a footnote.
    expect(prompt).toContain('art_a, art_b');
  });

  it('does not truncate bodies (planning context must survive intact)', () => {
    const big = 'X'.repeat(50_000);
    const prompt = claudeStagePrompt({
      ...baseInput('implementation'),
      contextArtifacts: [{ kind: 'execution_plan', title: 'Plan', body: big }],
    });
    expect(prompt).toContain(big);
    expect(prompt).not.toMatch(/truncated/i);
  });

  it('strips the redundant structured-json from a threaded body (prose only)', () => {
    const briefBody = [
      '## Task Brief',
      'AC1: toggle persists across reloads.',
      '',
      '## Structured summary',
      '',
      '```json',
      '{ "acceptance_criteria": [{ "id": "AC1" }] }',
      '```',
    ].join('\n');
    const prompt = claudeStagePrompt({
      ...baseInput('discovery'),
      contextArtifacts: [{ kind: 'task_brief', title: 'Brief', body: briefBody }],
    });
    // Isolate the threaded body (between "## Prior context" and the ids footnote /
    // the stage's own "## Output" section, which legitimately mentions a json block).
    const priorStart = prompt.indexOf('## Prior context');
    const priorEnd = prompt.indexOf('## Output');
    const priorSection = prompt.slice(priorStart, priorEnd);
    // The prose survives…
    expect(priorSection).toContain('AC1: toggle persists across reloads.');
    // …but the duplicate json + its heading are gone from the threaded copy.
    expect(priorSection).not.toContain('```json');
    expect(priorSection).not.toContain('## Structured summary');
    expect(priorSection).not.toContain('"acceptance_criteria"');
  });

  it('stripStructuredJson removes json blocks + Structured summary heading, keeps prose', () => {
    const out = stripStructuredJson(
      'Prose here.\n\n## Structured summary\n\n```json\n{"a":1}\n```',
    );
    expect(out).toBe('Prose here.');
  });

  it('contextKindsForStage encodes the upstream allowlist per stage', () => {
    expect(contextKindsForStage('task_brief')).toEqual([]);
    expect(contextKindsForStage('discovery')).toEqual(['task_brief']);
    expect(contextKindsForStage('implementation')).toEqual(['execution_plan', 'task_brief']);
    expect(contextKindsForStage('delivery_prep')).toEqual([
      'execution_plan',
      'validation_report',
      'demo_evidence',
      'self_review',
    ]);
    // Unknown stage -> no context.
    expect(contextKindsForStage('intake')).toEqual([]);
  });
});

describe('ClaudeAgentRuntimeAdapter (CLI-backed, injected fake runCli)', () => {
  /** A fake CLI runner that records the invocation and returns scripted output. */
  function fakeCli(result: Partial<CliResult>, capture?: { inv?: CliInvocation }) {
    return async (inv: CliInvocation): Promise<CliResult> => {
      if (capture) capture.inv = inv;
      return { code: 0, stdout: '', stderr: '', ...result };
    };
  }

  /** Encode a CLI JSON result the way `claude -p --output-format json` would. */
  const cliJson = (obj: Record<string, unknown>) => JSON.stringify({ type: 'result', ...obj });

  const claudeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
    taskId: 'task_1',
    stage: 'discovery',
    worktreePath: '/tmp/wt/task_1',
    contextArtifactIds: ['art_a', 'art_b'],
    allowedTools: allowedToolsForStage('discovery'),
    taskTitle: 'Add dark mode',
    rawRequest: 'Users want a dark mode toggle.',
    ...over,
  });

  /** Pull the value(s) following a flag out of an argv array. */
  const valuesAfter = (args: string[], flag: string): string[] => {
    const out: string[] = [];
    const i = args.indexOf(flag);
    if (i === -1) return out;
    for (let j = i + 1; j < args.length && !args[j]!.startsWith('--') && args[j] !== '-p'; j++) {
      out.push(args[j]!);
    }
    return out;
  };

  it('runs in -p json mode, confined to the worktree cwd, with the stage policy', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'done' }) }, capture),
    });

    await adapter.runStageAgent(claudeInput());

    const inv = capture.inv!;
    expect(inv.cwd).toBe('/tmp/wt/task_1'); // worktree confinement
    expect(inv.args).toContain('-p');
    expect(inv.args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(valuesAfter(inv.args, '--permission-mode')).toEqual(['plan']);
    expect(valuesAfter(inv.args, '--allowed-tools')).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob']),
    );
    // The real safety boundary for a read-only stage:
    expect(valuesAfter(inv.args, '--disallowed-tools')).toEqual(
      expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit']),
    );
  });

  it('implementation runs acceptEdits with Edit/Write/Bash allowed', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'x' }) }, capture),
    });

    await adapter.runStageAgent(
      claudeInput({
        stage: 'implementation',
        allowedTools: allowedToolsForStage('implementation'),
      }),
    );

    const inv = capture.inv!;
    expect(valuesAfter(inv.args, '--permission-mode')).toEqual(['acceptEdits']);
    expect(valuesAfter(inv.args, '--allowed-tools')).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'Bash']),
    );
    expect(inv.args).not.toContain('--disallowed-tools');
  });

  it('per-run model override (input.model) wins over the adapter default --model', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'x' }) }, capture),
      model: 'opus', // constructed default
    });

    await adapter.runStageAgent(claudeInput({ model: 'sonnet' }));

    // The per-run model is what the daemon sets per stage; it must beat the default.
    expect(valuesAfter(capture.inv!.args, '--model')).toEqual(['sonnet']);
  });

  it('falls back to the adapter default --model when no per-run model is set', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'x' }) }, capture),
      model: 'opus',
    });

    await adapter.runStageAgent(claudeInput()); // no input.model

    expect(valuesAfter(capture.inv!.args, '--model')).toEqual(['opus']);
  });

  it('passes input.effort as --effort', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'x' }) }, capture),
    });

    await adapter.runStageAgent(claudeInput({ effort: Effort.High }));

    // The argv token is the enum's string value, passed straight to --effort.
    expect(valuesAfter(capture.inv!.args, '--effort')).toEqual([Effort.High]);
  });

  it('omits --effort when no effort is set', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'x' }) }, capture),
    });

    await adapter.runStageAgent(claudeInput()); // no input.effort

    expect(capture.inv!.args).not.toContain('--effort');
  });

  it('passes a stage packet as the -p prompt, not task history', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'ok' }) }, capture),
    });

    await adapter.runStageAgent(claudeInput());
    const prompt = capture.inv!.args[capture.inv!.args.indexOf('-p') + 1]!;

    expect(prompt).toContain('discovery');
    expect(prompt).toContain('Add dark mode');
    expect(prompt).toContain('art_a, art_b');
    expect(prompt).not.toContain('stageRuns');
    expect(prompt).not.toContain('approvals');
  });

  describe('WORKBENCH_CAPTURE_PROMPTS diagnostics', () => {
    afterEach(() => {
      delete process.env.WORKBENCH_CAPTURE_PROMPTS;
    });

    it('is a no-op (no files) when the env var is unset', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-cap-off-'));
      try {
        const adapter = new ClaudeAgentRuntimeAdapter({
          runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'ok' }) }),
        });
        await adapter.runStageAgent(claudeInput());
        expect(readdirSync(dir)).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes the exact prompt with a header naming the stage + context ids', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-cap-on-'));
      process.env.WORKBENCH_CAPTURE_PROMPTS = dir;
      try {
        const adapter = new ClaudeAgentRuntimeAdapter({
          runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result: 'ok' }) }),
        });
        await adapter.runStageAgent(claudeInput());

        const files = readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d\d-discovery\.txt$/);
        const body = readFileSync(join(dir, files[0]!), 'utf8');
        expect(body).toContain('stage=discovery mode=stage-packet');
        expect(body).toContain('contextArtifactIds: art_a, art_b');
        // The captured prompt is byte-identical to what claudeStagePrompt builds.
        expect(body).toContain(claudeStagePrompt(claudeInput()));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('parses a fenced json block into a structured artifact + records the result', async () => {
    const finalText = [
      'Here is the discovery.',
      '```json',
      '{ "files": ["a.ts"], "risk": "low" }',
      '```',
    ].join('\n');
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({
        stdout: cliJson({
          subtype: 'success',
          result: finalText,
          total_cost_usd: 0.01,
          num_turns: 3,
        }),
      }),
    });

    const res = await adapter.runStageAgent(claudeInput());

    expect(res.status).toBe('succeeded');
    expect(res.produced).toHaveLength(1);
    expect(res.produced[0]!.kind).toBe(STAGE_TO_ARTIFACT['discovery']);
    expect(res.produced[0]!.body).toContain('"files"');
    expect(res.produced[0]!.body).toContain('"risk": "low"');
    expect(res.transcript.kind).toBe('log');
    expect(res.transcript.body).toContain('Here is the discovery.');
    expect(res.transcript.body).toContain('Cost (USD): 0.01');
  });

  it('fails (no produced) when there is no worktree — and never invokes the CLI', async () => {
    let called = false;
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: async () => {
        called = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const res = await adapter.runStageAgent(claudeInput({ worktreePath: undefined }));

    expect(called).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/worktree/);
    expect(res.produced).toHaveLength(0);
    expect(res.transcript.kind).toBe('log');
  });

  it('fails when the CLI reports an error subtype', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({
        stdout: cliJson({ subtype: 'error_max_turns', is_error: true, result: '' }),
      }),
    });
    const res = await adapter.runStageAgent(claudeInput());

    expect(res.status).toBe('failed');
    expect(res.produced).toHaveLength(0);
    expect(res.transcript.body).toContain('error_max_turns');
  });

  it('fails on a non-zero exit / unparseable output', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ code: 1, stdout: 'not json', stderr: 'boom' }),
    });
    const res = await adapter.runStageAgent(claudeInput());

    expect(res.status).toBe('failed');
    expect(res.produced).toHaveLength(0);
    expect(res.transcript.body).toContain('boom');
  });

  it('flags the artifact when a repoProfile run omits required compliance fields', async () => {
    // app/discovery requires testPlan + precedentTests; this output has neither.
    const result = 'Plan.\n```json\n{"approach":"x"}\n```';
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result }) }),
    });
    const res = await adapter.runStageAgent(
      claudeInput({
        stage: 'discovery',
        allowedTools: allowedToolsForStage('discovery'),
        repoProfile: 'app',
      }),
    );

    expect(res.status).toBe('succeeded');
    expect(res.produced[0]!.body).toContain('Skill compliance');
    expect(res.produced[0]!.body).toContain('precedentTests');
  });

  it('does not flag when the repoProfile compliance fields are present', async () => {
    const result =
      'Plan.\n```json\n{"testPlan":[{"target":"foo","cases":["a"]}],"precedentTests":["tests/x_test.py"]}\n```';
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCli: fakeCli({ stdout: cliJson({ subtype: 'success', result }) }),
    });
    const res = await adapter.runStageAgent(
      claudeInput({
        stage: 'discovery',
        allowedTools: allowedToolsForStage('discovery'),
        repoProfile: 'app',
      }),
    );

    expect(res.status).toBe('succeeded');
    expect(res.produced[0]!.body).not.toContain('Skill compliance');
  });
});

describe('ClaudeAgentRuntimeAdapter.streamStageAgent (injected NDJSON stream)', () => {
  const claudeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
    taskId: 'task_1',
    stage: 'discovery',
    worktreePath: '/tmp/wt/task_1',
    contextArtifactIds: ['art_a'],
    allowedTools: allowedToolsForStage('discovery'),
    taskTitle: 'Add dark mode',
    rawRequest: 'Users want a dark mode toggle.',
    ...over,
  });

  /** A streaming runner that replays scripted NDJSON lines, then closes with `code`. */
  function fakeStream(lines: string[], code = 0, capture?: { inv?: CliInvocation }) {
    return async (
      inv: CliInvocation,
      onLine: (line: string) => void | Promise<void>,
    ): Promise<CliStreamResult> => {
      if (capture) capture.inv = inv;
      for (const line of lines) await onLine(line);
      return { code, stderr: '' };
    };
  }

  /** Collect emitted events into an array handler. */
  function collecting(): { events: StreamEvent[]; handlers: StreamHandlers } {
    const events: StreamEvent[] = [];
    return {
      events,
      handlers: {
        onEvent: (e) => events.push(e),
        requestInput: bufferingHandlers().requestInput,
      },
    };
  }

  const textDelta = (text: string) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  const assistantToolUse = (name: string, input: unknown) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input }] },
    });
  const userToolResult = (content: string, isError = false) =>
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content, is_error: isError }] },
    });
  const result = (obj: Record<string, unknown>) => JSON.stringify({ type: 'result', ...obj });

  /** Pull the value(s) following a flag out of an argv array. */
  const valuesAfter = (args: string[], flag: string): string[] => {
    const out: string[] = [];
    const i = args.indexOf(flag);
    if (i === -1) return out;
    for (let j = i + 1; j < args.length && !args[j]!.startsWith('--') && args[j] !== '-p'; j++) {
      out.push(args[j]!);
    }
    return out;
  };

  it('uses stream-json flags, confined to the worktree cwd', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(claudeInput(), handlers);

    const inv = capture.inv!;
    expect(inv.cwd).toBe('/tmp/wt/task_1');
    expect(inv.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
    expect(inv.args).toContain('--verbose');
    expect(inv.args).toContain('--include-partial-messages');
  });

  it('advertises the ask tool as allowed for an ask-enabled gated run', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'discovery',
        allowedTools: allowedToolsForStage('discovery'),
        gate: { daemonUrl: 'http://127.0.0.1:1', runId: 'run_1' },
      }),
      handlers,
    );

    const inv = capture.inv!;
    expect(valuesAfter(inv.args, '--allowed-tools')).toContain(ASK_TOOL);
    // The gate is wired as the permission-prompt tool.
    expect(valuesAfter(inv.args, '--permission-prompt-tool')).toEqual([ASK_TOOL]);
  });

  it('does NOT advertise the ask tool when there is no gate (server not spawned)', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'discovery',
        allowedTools: allowedToolsForStage('discovery'),
      }),
      handlers,
    );

    expect(valuesAfter(capture.inv!.args, '--allowed-tools')).not.toContain(ASK_TOOL);
  });

  it('UNGATED implementation keeps Edit/Write/Bash on acceptEdits (autonomous auto-advance)', async () => {
    // The auto-advance implementation run has no human to answer edit prompts,
    // so it runs without a gate: mutating tools stay auto-approved and the mode
    // stays acceptEdits, letting the agent actually apply the plan.
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'implementation',
        allowedTools: allowedToolsForStage('implementation'),
        gate: undefined, // ungated autonomous run
      }),
      handlers,
    );

    const inv = capture.inv!;
    expect(valuesAfter(inv.args, '--permission-mode')).toEqual(['acceptEdits']);
    expect(valuesAfter(inv.args, '--allowed-tools')).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'Bash']),
    );
  });

  it('GATED implementation downgrades to default + strips mutating tools (would route to human)', async () => {
    // The interactive (gated) path deliberately routes edits to the human gate.
    // This documents WHY auto-advance must run ungated — gated unattended would
    // hang waiting for an approval that never comes.
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'implementation',
        allowedTools: allowedToolsForStage('implementation'),
        gate: { daemonUrl: 'http://127.0.0.1:1', runId: 'run_1' },
      }),
      handlers,
    );

    const inv = capture.inv!;
    expect(valuesAfter(inv.args, '--permission-mode')).toEqual(['default']);
    const allowed = valuesAfter(inv.args, '--allowed-tools');
    expect(allowed).not.toContain('Edit');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Bash');
  });

  it('hard-denies escape tools on the argv and names ONLY the stage tools in the system prompt', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(claudeInput(), handlers); // discovery

    const inv = capture.inv!;
    expect(valuesAfter(inv.args, '--disallowed-tools')).toEqual(
      expect.arrayContaining([
        'Bash',
        'Task',
        'Agent',
        'Skill',
        'Monitor',
        'ToolSearch',
        'ExitPlanMode',
      ]),
    );
    const sys = valuesAfter(inv.args, '--append-system-prompt')[0]!;
    expect(sys).toContain('Read, Grep, Glob');
    expect(sys).toContain('No other tools exist');
    // A read-only stage genuinely lacks Task, so the prohibition still names it.
    expect(sys).toContain('Task');
    // The cross-cutting output-quality BASE bar rides on EVERY stage's prompt.
    expect(sys).toContain('Output quality bar');
    expect(sys).toMatch(/Scale your output to the actual work/i);
    expect(sys).toMatch(/NOT a test case/i);
    // No-preamble rule rides on every stage: suppress the "Now I have enough
    // information, let me write…" narration that became the artifact's first line.
    expect(sys).toMatch(/Begin your reply DIRECTLY with the deliverable/i);
    expect(sys).toMatch(/Do NOT preface it with narration/i);
    // Discovery's artifact IS its deliverable, so the aggressive "delete any
    // sentence that only shows you understood the task" prune clause must NOT
    // ride on it — that clause made a planning agent delete its own plan.
    expect(sys).not.toMatch(/delete any sentence that would not change/i);
  });

  it('applies the prune clause to summary stages (brief) but not to planning', async () => {
    // Regression: the prune clause collapsed the Execution Plan to one sentence
    // (no json block) because, in read-only plan mode, the model read its own
    // plan as cuttable narration. The clause belongs on stages that SUMMARISE
    // work done elsewhere (brief, self-review), not on the plan itself.
    const sysFor = async (stage: AgentRunInput['stage']) => {
      const capture: { inv?: CliInvocation } = {};
      const adapter = new ClaudeAgentRuntimeAdapter({
        runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
      });
      const { handlers } = collecting();
      await adapter.streamStageAgent(
        claudeInput({ stage, allowedTools: allowedToolsForStage(stage) }),
        handlers,
      );
      return valuesAfter(capture.inv!.args, '--append-system-prompt')[0]!;
    };

    const brief = await sysFor('task_brief');
    const plan = await sysFor('discovery');
    // Base bar on both.
    expect(brief).toMatch(/Scale your output to the actual work/i);
    expect(plan).toMatch(/Scale your output to the actual work/i);
    // Prune clause on the brief, NOT on the plan.
    expect(brief).toMatch(/delete any sentence that would not change/i);
    expect(plan).not.toMatch(/delete any sentence that would not change/i);
  });

  it('does NOT forbid Task in the system prompt on a stage whose policy allows it', async () => {
    // Regression: the review/QA stages allow Task (the injected skill MANDATES
    // Task-subagent fan-out), but the prompt used to hardcode "do not call Task".
    // The contradiction made the model review inline. The prohibition must now be
    // derived from the allowlist — Task is allowed here, so it must not appear in it.
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'done' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'agent_self_review',
        allowedTools: allowedToolsForStage('agent_self_review'),
      }),
      handlers,
    );

    const inv = capture.inv!;
    // Task is on the auto-approval allowlist for this stage.
    expect(valuesAfter(inv.args, '--allowed-tools')).toContain('Task');
    const sys = valuesAfter(inv.args, '--append-system-prompt')[0]!;
    // The prohibition must not name Task (it's allowed) but must still name a
    // probe tool the stage lacks, and must actively point the agent at Task.
    expect(sys).not.toMatch(/do not call or search for[^.]*\bTask\b/);
    expect(sys).toMatch(/do not call or search for[^.]*\bToolSearch\b/);
    expect(sys).toContain('if Task is listed, use it');
  });

  it('watchdog kills and fails a run with no stream activity', async () => {
    // Runner emits one line then goes silent until aborted (the wedge).
    const runner = async (
      inv: CliInvocation,
      onLine: (line: string) => void | Promise<void>,
    ): Promise<CliStreamResult> => {
      await onLine(textDelta('exploring…'));
      await new Promise<void>((resolve) =>
        inv.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { code: 143, stderr: '' };
    };
    const adapter = new ClaudeAgentRuntimeAdapter({ runCliStreaming: runner, stallTimeoutMs: 50 });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/stalled: no stream activity/);
  });

  it('watchdog does NOT kill a run that is long-polling the ask gate', async () => {
    let aborted = false;
    const runner = async (
      inv: CliInvocation,
      onLine: (line: string) => void | Promise<void>,
    ): Promise<CliStreamResult> => {
      inv.signal!.addEventListener('abort', () => {
        aborted = true;
      });
      // The last line is the ask tool call — silence after it is the human
      // thinking, far longer than the stall window.
      await onLine(assistantToolUse(ASK_TOOL, { question: 'which approach?' }));
      await new Promise((r) => setTimeout(r, 250));
      await onLine(result({ subtype: 'success', result: 'done' }));
      return { code: 0, stderr: '' };
    };
    const adapter = new ClaudeAgentRuntimeAdapter({ runCliStreaming: runner, stallTimeoutMs: 50 });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    expect(aborted).toBe(false);
    expect(res.status).toBe('succeeded');
  });

  it('emits assistant_text, tool_call, tool_result, cost, result in order', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([
        textDelta('Looking at the repo. '),
        assistantToolUse('Read', { file_path: 'a.ts' }),
        userToolResult('contents of a.ts'),
        result({ subtype: 'success', result: 'done', total_cost_usd: 0.02, num_turns: 4 }),
      ]),
    });
    const { events, handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    // The `assistant` line carrying the tool_use now also opens a `turn` event
    // (per-turn TTFT) just before its tool_call.
    expect(events.map((e) => e.type)).toEqual([
      'assistant_text',
      'turn',
      'tool_call',
      'tool_result',
      'cost',
      'result',
    ]);
    expect(events[0]!.payload).toEqual({ text: 'Looking at the repo. ' });
    expect(events.find((e) => e.type === 'tool_call')!.payload).toMatchObject({ name: 'Read' });
    // No `usage` on this result line → token fields are null, cost/turns set.
    expect(events.find((e) => e.type === 'cost')!.payload).toEqual({
      totalCostUsd: 0.02,
      numTurns: 4,
      durationMs: null,
      durationApiMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(res.status).toBe('succeeded');
    expect(res.transcript.kind).toBe('log');
  });

  it('threads the result `usage` token breakdown into the cost event', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([
        result({
          subtype: 'success',
          result: 'done',
          total_cost_usd: 0.91,
          num_turns: 12,
          duration_ms: 45000,
          duration_api_ms: 31000,
          usage: {
            input_tokens: 22000,
            output_tokens: 4000,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: 310000,
          },
        }),
      ]),
    });
    const { events, handlers } = collecting();

    await adapter.streamStageAgent(claudeInput(), handlers);

    const costEvent = events.find((e) => e.type === 'cost');
    expect(costEvent?.payload).toEqual({
      totalCostUsd: 0.91,
      numTurns: 12,
      durationMs: 45000,
      durationApiMs: 31000,
      inputTokens: 22000,
      outputTokens: 4000,
      cacheCreationInputTokens: 1500,
      cacheReadInputTokens: 310000,
    });
  });

  it('parses a fenced json block from the final result into a structured artifact', async () => {
    const finalText = ['Discovery done.', '```json', '{ "files": ["a.ts"] }', '```'].join('\n');
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: finalText })]),
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    expect(res.status).toBe('succeeded');
    expect(res.produced).toHaveLength(1);
    expect(res.produced[0]!.kind).toBe(STAGE_TO_ARTIFACT['discovery']);
    const body = res.produced[0]!.body;
    // The body is the agent's OWN output, verbatim — its prose plus the single
    // json block it emitted. We no longer append a duplicate "## Structured
    // summary" copy (that doubled the json in the body and in any downstream
    // prompt the body is threaded into).
    expect(body).toContain('Discovery done.');
    expect(body).toContain('"files"');
    expect(body).not.toContain('## Structured summary');
    // Exactly ONE fenced json block (the agent's), not two.
    expect([...body.matchAll(/```json/g)]).toHaveLength(1);
  });

  it('banners a structure-required stage that collapsed to a stub (no json, tiny prose)', async () => {
    // The regression: a planning agent ran its turns but its FINAL reply was one
    // closing sentence with no json block. Stored verbatim, that stub threads into
    // implementation as the "plan." The guard must flag it (non-fatally) at the gate.
    const stub = 'The execution plan is complete. Implementation will proceed in order.';
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: stub })]),
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(
      claudeInput({ stage: 'discovery', allowedTools: allowedToolsForStage('discovery') }),
      handlers,
    );

    // Non-fatal: the run still succeeds and produces the artifact (a human bounces it).
    expect(res.status).toBe('succeeded');
    expect(res.produced).toHaveLength(1);
    const body = res.produced[0]!.body;
    expect(body).toMatch(/⚠️ \*\*Artifact looks empty\/unstructured:\*\*/);
    expect(body).toContain('no structured json block');
    // The agent's prose is still preserved below the banner.
    expect(body).toContain('The execution plan is complete');
  });

  it('does NOT banner a structure-required stage with a full plan + json block', async () => {
    const fullPlan = [
      '# Execution Plan',
      '',
      'Two-module package: engine.py holds the pure rules; cli.py is the I/O loop.',
      'Ordered change list: (1) engine with legal_moves/apply_move/score, (2) the',
      'pytest suite binding each acceptance criterion, (3) the CLI render+input loop.',
      'Validation: every AC maps to a unit test except the interactive loop (manual).',
      '',
      '```json',
      '{ "approach": "engine+cli", "change_list": ["engine", "tests", "cli"] }',
      '```',
    ].join('\n');
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: fullPlan })]),
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(
      claudeInput({ stage: 'discovery', allowedTools: allowedToolsForStage('discovery') }),
      handlers,
    );

    const body = res.produced[0]!.body;
    expect(body).not.toMatch(/Artifact looks empty\/unstructured/);
    expect([...body.matchAll(/```json/g)]).toHaveLength(1);
  });

  it('fails (no produced) when there is no worktree, without invoking the CLI', async () => {
    let called = false;
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: async () => {
        called = true;
        return { code: 0, stderr: '' };
      },
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput({ worktreePath: undefined }), handlers);

    expect(called).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/worktree/);
  });

  it('fails when the terminal result reports an error subtype', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'error_max_turns', is_error: true })]),
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    expect(res.status).toBe('failed');
    expect(res.produced).toHaveLength(0);
  });

  const systemInit = (sessionId: string) =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId });

  it('captures the session id from the system/init line onto the result', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([
        systemInit('sess_abc'),
        result({ subtype: 'success', result: 'done' }),
      ]),
    });
    const { handlers } = collecting();

    const res = await adapter.streamStageAgent(claudeInput(), handlers);

    expect(res.status).toBe('succeeded');
    expect(res.sessionId).toBe('sess_abc');
  });

  it('resume mode sends ONLY the message and adds --resume <id>, no stage packet', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new ClaudeAgentRuntimeAdapter({
      runCliStreaming: fakeStream([result({ subtype: 'success', result: 'revised' })], 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(
      claudeInput({
        stage: 'task_brief',
        resume: { sessionId: 'sess_abc', message: 'make it more concise' },
      }),
      handlers,
    );

    const args = capture.inv!.args;
    // --resume carries the session id.
    expect(valuesAfter(args, '--resume')).toEqual(['sess_abc']);
    // The -p prompt is JUST the reviewer's comment — not the stage packet.
    const promptIdx = args.indexOf('-p');
    expect(args[promptIdx + 1]).toBe('make it more concise');
    expect(args[promptIdx + 1]).not.toContain('# Stage:');
  });
});

describe('consumeStreamLine — per-turn TTFT + usage capture', () => {
  /** Collect emitted events; drive `consumeStreamLine` with a controllable clock. */
  function harness() {
    const events: StreamEvent[] = [];
    const handlers: StreamHandlers = {
      onEvent: (e) => events.push(e),
      requestInput: bufferingHandlers().requestInput,
    };
    const acc: StreamAccumulator = newStreamAccumulator();
    let t = 0;
    const now = () => t;
    const advance = (ms: number) => {
      t += ms;
    };
    const feed = (line: object) => consumeStreamLine(JSON.stringify(line), acc, handlers, now);
    return {
      events,
      acc,
      now,
      advance,
      feed,
      setBoundary: (ms: number) => (acc.turnBoundaryMs = ms),
    };
  }

  const messageStart = { type: 'stream_event', event: { type: 'message_start' } };
  const textDeltaLine = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
  const assistantWithUsage = (usage: Record<string, number>, toolUse?: object) => ({
    type: 'assistant',
    message: {
      usage,
      content: toolUse ? [toolUse] : [],
    },
  });
  const toolResultLine = (content: string) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', content }] },
  });

  it('emits one `turn` event per assistant line, with ttft from boundary to first token', () => {
    const h = harness();
    h.setBoundary(0); // run start (the adapter stamps this at prompt-send)
    h.advance(50_000); // 50s of silence — model prefilling
    h.feed(messageStart); // first token arrives
    h.advance(400);
    h.feed(textDeltaLine('Hello'));
    h.feed(
      assistantWithUsage({
        input_tokens: 120_000,
        output_tokens: 800,
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 0,
      }),
    );

    const turns = h.events.filter((e) => e.type === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.payload).toEqual({
      index: 1,
      ttftMs: 50_000,
      inputTokens: 120_000,
      outputTokens: 800,
      cacheReadInputTokens: 90_000,
      cacheCreationInputTokens: 0,
    });
  });

  it('resets the boundary on tool_result so turn 2 ttft is measured from the result', () => {
    const h = harness();
    h.setBoundary(0);
    // Turn 1
    h.advance(10_000);
    h.feed(messageStart);
    h.feed(
      assistantWithUsage({ input_tokens: 10_000 }, { type: 'tool_use', name: 'Read', input: {} }),
    );
    // Tool runs, result handed back — opens turn 2's clock.
    h.advance(2_000);
    h.feed(toolResultLine('file contents'));
    // Turn 2: 60s of silent prefill before first token.
    h.advance(60_000);
    h.feed(messageStart);
    h.feed(assistantWithUsage({ input_tokens: 135_000, cache_read_input_tokens: 120_000 }));

    const turns = h.events.filter((e) => e.type === 'turn');
    expect(turns.map((t) => t.payload)).toEqual([
      expect.objectContaining({ index: 1, ttftMs: 10_000 }),
      // Measured from the tool_result (not run start): 60s, NOT 72s.
      expect.objectContaining({ index: 2, ttftMs: 60_000, inputTokens: 135_000 }),
    ]);
  });

  it('emits a turn with null token fields when the assistant line omits usage', () => {
    const h = harness();
    h.setBoundary(0);
    h.advance(5_000);
    h.feed(messageStart);
    h.feed({ type: 'assistant', message: { content: [] } }); // older CLI: no usage

    const turns = h.events.filter((e) => e.type === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.payload).toEqual({
      index: 1,
      ttftMs: 5_000,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    });
  });

  it('falls back to the assistant line for first-token time when no partial-message events stream', () => {
    const h = harness();
    h.setBoundary(0);
    h.advance(30_000);
    // No message_start/deltas (e.g. --include-partial-messages absent): the
    // assistant line itself is the first observed model emission.
    h.feed(assistantWithUsage({ input_tokens: 8_000 }));

    const turns = h.events.filter((e) => e.type === 'turn');
    expect(turns[0]!.payload).toMatchObject({ index: 1, ttftMs: 30_000 });
  });

  it('orders the `turn` event before that turn’s tool_call events', () => {
    const h = harness();
    h.setBoundary(0);
    h.feed(messageStart);
    h.feed(
      assistantWithUsage(
        { input_tokens: 1 },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ),
    );

    const types = h.events.map((e) => e.type);
    expect(types.indexOf('turn')).toBeLessThan(types.indexOf('tool_call'));
  });
});

describe('ClaudeAgentRuntimeAdapter — Klaviyo Linear/Sentry MCP wiring', () => {
  const FAKE_SERVERS: Record<string, McpServerDef> = {
    'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' },
    sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
  };
  /** Fake reader: returns the requested subset of FAKE_SERVERS (mirrors the real one). */
  const fakeReader = (names: readonly string[]): Record<string, McpServerDef> =>
    Object.fromEntries(names.filter((n) => n in FAKE_SERVERS).map((n) => [n, FAKE_SERVERS[n]!]));

  const claudeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
    taskId: 'task_1',
    stage: 'task_brief',
    worktreePath: '/tmp/wt/task_1',
    contextArtifactIds: [],
    allowedTools: allowedToolsForStage('task_brief'),
    taskTitle: 'Fix CORE-242',
    rawRequest: 'See ticket.',
    repoProfile: 'app',
    ...over,
  });

  const valuesAfter = (args: string[], flag: string): string[] => {
    const out: string[] = [];
    const i = args.indexOf(flag);
    if (i === -1) return out;
    for (let j = i + 1; j < args.length && !args[j]!.startsWith('--') && args[j] !== '-p'; j++) {
      out.push(args[j]!);
    }
    return out;
  };

  /** Read back the mcpServers map the adapter wrote for `--mcp-config`. */
  const writtenServers = (args: string[]): Record<string, McpServerDef> => {
    const path = valuesAfter(args, '--mcp-config')[0];
    if (!path) return {};
    return (
      (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerDef> })
        .mcpServers ?? {}
    );
  };

  const okStream = (capture: { inv?: CliInvocation }) =>
    new ClaudeAgentRuntimeAdapter({
      readMcpServers: fakeReader,
      runCliStreaming: async (inv, onLine) => {
        capture.inv = inv;
        await onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
        return { code: 0, stderr: '' };
      },
    });
  const okCli = (capture: { inv?: CliInvocation }) =>
    new ClaudeAgentRuntimeAdapter({
      readMcpServers: fakeReader,
      runCli: async (inv) => {
        capture.inv = inv;
        return {
          code: 0,
          stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
          stderr: '',
        };
      },
    });

  it('connects Linear+Sentry for an app-profile task_brief (one-shot path)', async () => {
    const capture: { inv?: CliInvocation } = {};
    await okCli(capture).runStageAgent(claudeInput({ stage: 'task_brief' }));
    const args = capture.inv!.args;
    expect(args).toContain('--strict-mcp-config');
    expect(Object.keys(writtenServers(args)).sort()).toEqual(['linear-server', 'sentry']);
  });

  it('connects Linear+Sentry for an app-profile discovery (streaming path)', async () => {
    const capture: { inv?: CliInvocation } = {};
    await okStream(capture).streamStageAgent(
      claudeInput({ stage: 'discovery', allowedTools: allowedToolsForStage('discovery') }),
      bufferingHandlers(),
    );
    expect(Object.keys(writtenServers(capture.inv!.args)).sort()).toEqual([
      'linear-server',
      'sentry',
    ]);
  });

  it('does NOT connect them for a non-enterprise profile', async () => {
    const capture: { inv?: CliInvocation } = {};
    await okStream(capture).streamStageAgent(
      claudeInput({ stage: 'task_brief', repoProfile: 'ts-shadcn-frontend' }),
      bufferingHandlers(),
    );
    expect(capture.inv!.args).not.toContain('--mcp-config');
  });

  it('does NOT connect them on a stage outside brief/discovery (e.g. self-review)', async () => {
    const capture: { inv?: CliInvocation } = {};
    await okStream(capture).streamStageAgent(
      claudeInput({
        stage: 'agent_self_review',
        allowedTools: allowedToolsForStage('agent_self_review'),
      }),
      bufferingHandlers(),
    );
    expect(capture.inv!.args).not.toContain('--mcp-config');
  });

  it('merges the ask gate server with Linear+Sentry on a gated enterprise run', async () => {
    const capture: { inv?: CliInvocation } = {};
    await okStream(capture).streamStageAgent(
      claudeInput({
        stage: 'discovery',
        allowedTools: allowedToolsForStage('discovery'),
        gate: { daemonUrl: 'http://127.0.0.1:1', runId: 'run_1' },
      }),
      bufferingHandlers(),
    );
    const args = capture.inv!.args;
    expect(Object.keys(writtenServers(args)).sort()).toEqual(['ask', 'linear-server', 'sentry']);
    // The gate is still wired as the permission-prompt tool.
    expect(valuesAfter(args, '--permission-prompt-tool')).toEqual([ASK_TOOL]);
  });
});

describe('ClaudeAgentRuntimeAdapter.streamStageAgent — external stop signal', () => {
  const streamInput = (signal: AbortSignal): AgentRunInput => ({
    taskId: 'task_1',
    stage: 'discovery',
    worktreePath: '/tmp/wt/task_1',
    contextArtifactIds: ['art_a'],
    allowedTools: allowedToolsForStage('discovery'),
    taskTitle: 'Add dark mode',
    rawRequest: 'Users want a dark mode toggle.',
    signal,
  });

  /**
   * A streaming runner that models a killable subprocess: if the (watchdog or
   * external) abort signal fires, it rejects like a SIGKILL'd spawn instead of
   * resolving cleanly — exactly what the real `child.kill('SIGKILL')` path does.
   */
  const killableStream = async (
    inv: CliInvocation,
    _onLine: (line: string) => void | Promise<void>,
  ): Promise<CliStreamResult> => {
    if (inv.signal?.aborted) throw new Error('killed (SIGKILL)');
    return new Promise<CliStreamResult>((_resolve, reject) => {
      inv.signal?.addEventListener('abort', () => reject(new Error('killed (SIGKILL)')), {
        once: true,
      });
    });
  };

  it('reports a failed "stopped by operator" result when the signal is already aborted', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({ runCliStreaming: killableStream });
    const controller = new AbortController();
    controller.abort();
    const events: StreamEvent[] = [];
    const res = await adapter.streamStageAgent(streamInput(controller.signal), {
      onEvent: (e) => events.push(e),
      requestInput: bufferingHandlers().requestInput,
    });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('stopped by operator');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('aborts an in-flight run when the signal fires mid-stream', async () => {
    const adapter = new ClaudeAgentRuntimeAdapter({ runCliStreaming: killableStream });
    const controller = new AbortController();
    const res = adapter.streamStageAgent(streamInput(controller.signal), bufferingHandlers());
    controller.abort();
    const outcome = await res;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('stopped by operator');
  });
});
