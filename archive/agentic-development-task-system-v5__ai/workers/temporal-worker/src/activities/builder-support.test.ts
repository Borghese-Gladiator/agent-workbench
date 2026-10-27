import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHeadSha } from '@awb/repository';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from '@awb/agent-gateway';
import type { PlanSlice } from '@awb/domain';
import { runRealBuilderAttempt, buildBuilderInstruction, readBuildUiSkillContent } from './builder-support.js';

const execFileAsync = promisify(execFile);

/**
 * A fake CodingAgentAdapter whose `execute` performs a supplied side effect in the worktree
 * (standing in for the real agent's file edits) — lets us prove runRealBuilderAttempt's
 * commit/diff/SHA logic without a live model or API key.
 */
class FakeBuilderAdapter implements CodingAgentAdapter {
  readonly id = 'fake-builder';
  private cwd = '';
  /** Captures the createSession input so tests can assert the resume id was threaded. */
  lastCreateInput?: CreateAgentSessionInput;
  /** Captures the execute assignment so tests can assert the instruction handed to the model. */
  lastAssignment?: AgentAssignment;
  constructor(
    private readonly onExecute: (cwd: string) => Promise<void>,
    private readonly completed = true,
    private readonly executeSessionId?: string,
  ) {}

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.cwd = input.cwd;
    this.lastCreateInput = input;
    return { id: 'sess-1', role: input.role, taskId: input.taskId, providerId: this.id, createdAt: '' };
  }
  async execute(_s: AgentSession, a: AgentAssignment, _sink: AgentEventSink): Promise<AgentExecutionResult> {
    this.lastAssignment = a;
    await this.onExecute(this.cwd);
    return {
      completed: this.completed,
      findings: [],
      summary: 'fake builder ran',
      usage: { provider: 'fake', model: 'fake', inputTokens: 42, outputTokens: 7 },
      ...(this.executeSessionId ? { sessionId: this.executeSessionId } : {}),
    };
  }
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const slice: PlanSlice = {
  id: 'slice-1',
  objective: 'add a greeting file',
  claimIds: [],
  likelyPaths: ['greeting.txt'],
  requiredTargetedChecks: ['test'],
  dependencies: [],
};

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-builder-wt-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('buildBuilderInstruction', () => {
  it('returns the bare objective when there are no prior findings', () => {
    expect(buildBuilderInstruction('do the thing')).toBe('do the thing');
    expect(buildBuilderInstruction('do the thing', [])).toBe('do the thing');
  });

  it('renders severity, description, path:line, and remediation per finding', () => {
    const out = buildBuilderInstruction('do the thing', [
      {
        id: 'f-1',
        taskId: 't',
        severity: 'blocker',
        category: 'correctness',
        claimIds: [],
        path: 'a.ts',
        line: 9,
        description: 'boom',
        proposedRemediation: 'guard it',
        status: 'open',
      },
    ]);
    expect(out).toContain('do the thing');
    expect(out).toContain('[blocker] boom (a.ts:9)');
    expect(out).toContain('fix: guard it');
  });

  it('omits path/line and remediation when a finding lacks them', () => {
    const out = buildBuilderInstruction('obj', [
      { id: 'f', taskId: 't', severity: 'high', category: 'requirements', claimIds: [], description: 'no target touched', status: 'open' },
    ]);
    expect(out).toContain('[high] no target touched');
    expect(out).not.toContain('(');
    expect(out).not.toContain('fix:');
  });

  it('inlines skill content ahead of the objective when supplied', () => {
    const out = buildBuilderInstruction('build a dashboard', undefined, 'Restrained, precise house style.');
    expect(out).toContain('build a dashboard');
    expect(out).toContain('Follow this skill');
    expect(out).toContain('Restrained, precise house style.');
  });

  it('renders skill content AND prior findings together', () => {
    const out = buildBuilderInstruction(
      'build a dashboard',
      [{ id: 'f', taskId: 't', severity: 'high', category: 'correctness', claimIds: [], description: 'bug', status: 'open' }],
      'house style guidance',
    );
    expect(out).toContain('house style guidance');
    expect(out).toContain('A prior attempt failed QA/review');
    expect(out).toContain('bug');
  });

  it('omits the skill block entirely when no skill content is supplied', () => {
    expect(buildBuilderInstruction('do the thing')).not.toContain('Follow this skill');
  });
});

describe('readBuildUiSkillContent', () => {
  it('reads the real build-ui skill file from agent-workbench\'s own repo and strips its frontmatter', async () => {
    const content = await readBuildUiSkillContent();
    expect(content).toBeDefined();
    expect(content).not.toMatch(/^---/);
    expect(content).toMatch(/# Build UI/);
  });
});

describe('runRealBuilderAttempt (Stage 2 real builder)', () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await makeWorktree();
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it('commits the agent-produced diff and returns a real advancing candidate SHA', async () => {
    const baseSha = await getHeadSha(worktree);
    const adapter = new FakeBuilderAdapter(async (cwd) => {
      await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
    });

    const result = await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    expect(result.outcome.success).toBe(true);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.headSha).not.toBe(baseSha);

    // The change is really committed on the branch.
    const { stdout } = await execFileAsync('git', ['show', '--stat', 'HEAD'], { cwd: worktree });
    expect(stdout).toContain('greeting.txt');

    // The builder reports the session's usage + wall-clock for per-phase aggregation.
    expect(result.usage).toEqual({ provider: 'fake', model: 'fake', inputTokens: 42, outputTokens: 7 });
    expect(result.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it('reports noMeaningfulDiff when an INCOMPLETE session changes nothing (stuck signal)', async () => {
    const baseSha = await getHeadSha(worktree);
    const adapter = new FakeBuilderAdapter(async () => {
      // no file change
    }, /* completed */ false);

    const result = await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    expect(result.outcome.success).toBe(false);
    expect(result.outcome.noMeaningfulDiff).toBe(true);
    expect(result.headSha).toBe(baseSha);
  });

  // A completed session that deliberately makes no edit (a discovery/inventory or verify-only
  // slice) is a legitimate no-op, not a stuck loop — it must succeed so an over-decomposed plan
  // doesn't stall the implement phase.
  it('treats a COMPLETED no-edit session as a successful no-op slice', async () => {
    const baseSha = await getHeadSha(worktree);
    const adapter = new FakeBuilderAdapter(async () => {
      // no file change, but the session ran to completion
    }, /* completed */ true);

    const result = await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    expect(result.outcome.success).toBe(true);
    expect(result.outcome.noMeaningfulDiff).toBeUndefined();
    expect(result.headSha).toBe(baseSha);
  });

  // A resume token supplied to the attempt is threaded into createSession, and the provider's
  // session token from execute is surfaced back so a caller can persist it for the next retry.
  it('threads resumeSessionId into the session and returns the provider sessionId', async () => {
    const adapter = new FakeBuilderAdapter(
      async (cwd) => {
        await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
      },
      /* completed */ true,
      /* executeSessionId */ 'provider-session-99',
    );

    const result = await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
      resumeSessionId: 'prior-session-42',
    });

    expect(adapter.lastCreateInput?.resumeSessionId).toBe('prior-session-42');
    expect(result.sessionId).toBe('provider-session-99');
  });

  // TASK-63 repair loop: prior QA/review findings are rendered into the builder instruction so a
  // repair attempt re-implements knowing exactly what to fix, not blind.
  it('renders priorFindings (desc + path:line + remediation) into the builder instruction on repair', async () => {
    const adapter = new FakeBuilderAdapter(async (cwd) => {
      await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
    });

    await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
      priorFindings: [
        {
          id: 'f-1',
          taskId: 'task-1',
          severity: 'high',
          category: 'correctness',
          claimIds: ['claim-1'],
          path: 'src/rank.ts',
          line: 42,
          description: 'higher rank does not beat lower',
          proposedRemediation: 'compare rank ordinals',
          status: 'open',
        },
      ],
    });

    const instruction = adapter.lastAssignment?.instruction ?? '';
    expect(instruction).toContain(slice.objective);
    expect(instruction).toContain('A prior attempt failed QA/review');
    expect(instruction).toContain('higher rank does not beat lower');
    expect(instruction).toContain('src/rank.ts:42');
    expect(instruction).toContain('compare rank ordinals');
  });

  it('uses the bare slice objective when no priorFindings are supplied (first attempt)', async () => {
    const adapter = new FakeBuilderAdapter(async (cwd) => {
      await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
    });

    await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    expect(adapter.lastAssignment?.instruction).toBe(slice.objective);
  });

  // The builder agent's cwd is the TARGET repo (see makeWorktree above), never agent-workbench's
  // own — it can never see `.claude/skills/build-ui/SKILL.md` via native discovery. Proves the
  // real skill file's content reaches the instruction even though the session runs elsewhere.
  it('inlines the real build-ui skill content when the plan slice sets usesBuildUiSkill', async () => {
    const adapter = new FakeBuilderAdapter(async (cwd) => {
      await writeFile(join(cwd, 'dashboard.tsx'), '// new dashboard\n');
    });
    const uiSlice: PlanSlice = { ...slice, usesBuildUiSkill: true };

    await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice: uiSlice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    const instruction = adapter.lastAssignment?.instruction ?? '';
    expect(instruction).toContain(slice.objective);
    expect(instruction).toMatch(/Follow this skill/);
    expect(instruction).toMatch(/Build UI/);
  });

  it('does not inline any skill content when the slice leaves usesBuildUiSkill unset', async () => {
    const adapter = new FakeBuilderAdapter(async (cwd) => {
      await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
    });

    await runRealBuilderAttempt({
      adapter,
      taskId: 'task-1',
      worktreePath: worktree,
      slice,
      allowedTools: [],
      tokenBudget: 1000,
      runtimeBudgetMs: 1000,
      eventSink: () => {},
    });

    expect(adapter.lastAssignment?.instruction).not.toMatch(/Follow this skill/);
  });
});
