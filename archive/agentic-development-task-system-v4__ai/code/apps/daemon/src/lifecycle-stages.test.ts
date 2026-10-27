/**
 * Unit tests for:
 * A. Baseline Evidence — runs real static-analysis; non-halting; mock fallback.
 * C. Validation Demo — static gate + QA agent on claude; mock/shell fallback; failures park.
 * D. Skip Worktree — worktreeMode:'direct'; no worktree created; cwd → repoPath.
 * E. Implementation — auto-advance RUNS the real agent (claude); parks on failure.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter } from '@workbench/agents';
import { Store } from '@workbench/store';
import type { ValidationKind, ValidationRequest, ValidationResult } from '@workbench/validation';
import { StubWorktreeProvider } from '@workbench/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleService, type SyncValidationRunner } from './service.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let store: Store;
let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-ls-test-'));
  store = new Store({ dbPath: ':memory:', artifactsDir });
});

afterEach(() => {
  store.close();
  rmSync(artifactsDir, { recursive: true, force: true });
});

/** Build a fake SyncValidationRunner where each kind returns a specified result. */
function fakeRunner(
  results: Partial<Record<ValidationKind, Pick<ValidationResult, 'status' | 'output'>>>,
): SyncValidationRunner {
  return {
    run: async (req: ValidationRequest): Promise<ValidationResult> => {
      const override = results[req.kind];
      if (!req.command.trim()) return { kind: req.kind, status: 'skipped', output: '' };
      return {
        kind: req.kind,
        status: override?.status ?? 'passed',
        output: override?.output ?? '',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A. Baseline comparison inside Verification
//
// Baseline is no longer a stage. Verification captures it LAZILY (only on a
// post-change failure) against the project's pre-change checkout, and gates on
// NEW failures only: a check that was ALREADY failing pre-change must not park.
// ---------------------------------------------------------------------------

/**
 * A runner whose result for a kind depends on the cwd it runs in. Lets a test
 * model "fails in the worktree (post-change) but the base checkout was X" —
 * Verification runs in the worktree, the baseline runs in `baseCwd`.
 */
function cwdAwareRunner(
  baseCwd: string,
  perCwd: {
    base: Partial<Record<ValidationKind, Pick<ValidationResult, 'status' | 'output'>>>;
    worktree: Partial<Record<ValidationKind, Pick<ValidationResult, 'status' | 'output'>>>;
  },
): SyncValidationRunner {
  return {
    run: async (req: ValidationRequest): Promise<ValidationResult> => {
      if (!req.command.trim()) return { kind: req.kind, status: 'skipped', output: '' };
      const table = req.cwd === baseCwd ? perCwd.base : perCwd.worktree;
      const override = table[req.kind];
      return {
        kind: req.kind,
        status: override?.status ?? 'passed',
        output: override?.output ?? '',
      };
    },
  };
}

describe('Verification baseline comparison', () => {
  /** A verification task with a real on-disk worktree distinct from repoPath. */
  function setupWithWorktree(runner: SyncValidationRunner, baseRepo: string) {
    const project = store.createProject({
      name: 'P',
      repoPath: baseRepo,
      defaultBranch: 'main',
      agentRuntime: 'mock',
      testCommand: 'vitest',
      e2eCommand: 'playwright test',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do x' });
    const wtPath = mkdtempSync(join(tmpdir(), 'wb-wt-'));
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      undefined,
      undefined,
      runner,
    );
    store.createWorktree({
      taskId: task.id,
      worktreePath: wtPath,
      branch: 'wb/t',
      baseBranch: 'main',
      status: 'created',
    });
    store.applyTransition(task.id, { stage: 'static_checks', status: 'active' });
    return { project, task, svc, wtPath };
  }

  it('PARKS on a NEW failure (test green pre-change, red post-change)', async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), 'wb-base-'));
    const runner = cwdAwareRunner(baseRepo, {
      base: { test: { status: 'passed', output: 'all green before' } },
      worktree: { test: { status: 'failed', output: '3 failed' } },
    });
    const { task, svc } = setupWithWorktree(runner, baseRepo);

    const result = await svc.runStaticChecks(task.id);

    // The change introduced the failure -> must park at the static gate.
    expect(result.stage).toBe('static_checks');
    // The baseline was captured for the audit trail.
    expect(store.listArtifacts(task.id).some((a) => a.kind === 'baseline_evidence')).toBe(true);
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it('ADVANCES when the same failure pre-existed (red before AND after)', async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), 'wb-base-'));
    const runner = cwdAwareRunner(baseRepo, {
      base: { test: { status: 'failed', output: 'already broken' } },
      worktree: { test: { status: 'failed', output: 'still broken' } },
    });
    const { task, svc } = setupWithWorktree(runner, baseRepo);

    const result = await svc.runStaticChecks(task.id);

    // Pre-existing failure is not a regression -> advance past static_checks to E2E.
    expect(result.stage).toBe('feature_e2e');
    expect(store.listArtifacts(task.id).some((a) => a.kind === 'baseline_evidence')).toBe(true);
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it('does NOT capture a baseline when static checks are fully green', async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), 'wb-base-'));
    const runner = cwdAwareRunner(baseRepo, {
      base: {},
      worktree: { test: { status: 'passed', output: 'ok' } },
    });
    const { task, svc } = setupWithWorktree(runner, baseRepo);

    const result = await svc.runStaticChecks(task.id);

    expect(result.stage).toBe('feature_e2e');
    // Lazy: no failure to adjudicate -> no baseline captured.
    expect(store.listArtifacts(task.id).some((a) => a.kind === 'baseline_evidence')).toBe(false);
    rmSync(baseRepo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// C. Demo Evidence / E2E
// ---------------------------------------------------------------------------

describe('runVerification — static gate + demo evidence', () => {
  /**
   * A fake claude QA agent whose run outcome is controllable. On success it
   * produces a real (non-mock) `demo_evidence` bundle — standing in for the
   * Playwright video/trace/verdict the real `qa-*` skills assemble.
   */
  function fakeQaAgent(
    status: 'succeeded' | 'failed',
    opts: { writeProof?: boolean } = {},
  ): AgentRuntimeAdapter {
    return {
      async runStageAgent(input: AgentRunInput) {
        // The verification fork now runs the QA stage AND the cold self-review
        // stage concurrently against this same adapter. Respond per stage so each
        // run produces its own artifact kind (as the real adapter does), instead
        // of every succeeded run emitting demo_evidence.
        if (input.stage === 'agent_self_review') {
          return {
            status: 'succeeded' as const,
            transcript: { kind: 'log' as const, title: 'run review', body: 'review transcript' },
            produced: [
              {
                kind: 'self_review' as const,
                title: 'Self-Review',
                body: '# Self-Review\n\nNo blocking issues.',
              },
            ],
          };
        }
        // Stand in for the harness. The feature_e2e gate reads the Playwright JSON
        // reporter verdict from QA_OUTPUT_DIR/results.json, so a succeeded run must
        // write one with at least one expected (passed) spec and no unexpected
        // (failed) — otherwise the gate correctly parks. Proof media is optional.
        if (status === 'succeeded' && input.env?.QA_OUTPUT_DIR) {
          mkdirSync(input.env.QA_OUTPUT_DIR, { recursive: true });
          writeFileSync(
            join(input.env.QA_OUTPUT_DIR, 'results.json'),
            JSON.stringify({ stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 } }),
          );
        }
        if (status === 'succeeded' && opts.writeProof && input.env?.QA_OUTPUT_DIR) {
          const out = join(input.env.QA_OUTPUT_DIR, 'test-results', 'walkthrough-chromium');
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, 'video.webm'), 'FAKE_VIDEO');
          writeFileSync(join(out, 'trace.zip'), 'FAKE_TRACE');
          writeFileSync(join(out, 'screenshot.png'), 'FAKE_PNG');
        }
        return {
          status,
          transcript: { kind: 'log' as const, title: `run ${input.stage}`, body: 'qa transcript' },
          produced:
            status === 'succeeded'
              ? [
                  {
                    kind: 'demo_evidence' as const,
                    title: 'Demo Evidence',
                    body: '# Demo Evidence\n\nVerdict: PASSED\nVideo: trace.zip\nE2E: 5 passed',
                  },
                ]
              : [],
          error: status === 'failed' ? 'qa agent failed' : undefined,
        };
      },
    };
  }

  function setupValidationTask(opts: {
    agentRuntime: 'mock' | 'claude';
    e2eCommand?: string;
    runner?: SyncValidationRunner;
    agent?: AgentRuntimeAdapter;
    repoPath?: string;
    daemonUrl?: string;
  }) {
    const project = store.createProject({
      name: 'P',
      repoPath: opts.repoPath ?? process.cwd(),
      defaultBranch: 'main',
      agentRuntime: opts.agentRuntime,
      // A configured test command so the static gate actually RUNS (the fake
      // runner skips empty commands), letting `runner` overrides take effect.
      testCommand: 'vitest',
      e2eCommand: opts.e2eCommand ?? '',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do x' });
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      opts.agent ? () => opts.agent! : undefined,
      opts.daemonUrl,
      opts.runner ?? fakeRunner({}),
    );
    store.applyTransition(task.id, { stage: 'static_checks', status: 'active' });
    return { project, task, svc };
  }

  /**
   * Drive both verification sub-stages (static_checks -> feature_e2e) the way the
   * auto-advance driver would, returning the task after the E2E stage. Stops early
   * (returning the parked task) if static_checks does not advance to feature_e2e.
   */
  async function runVerificationStages(
    svc: LifecycleService,
    taskId: string,
  ): Promise<{ stage: string; status: string }> {
    const afterStatic = await svc.runStaticChecks(taskId);
    if (afterStatic.stage !== 'feature_e2e') return afterStatic;
    return svc.runFeatureE2e(taskId);
  }

  it('runs the QA agent on a claude project and stores its real demo_evidence', async () => {
    // The static half passes (test green) and the QA agent produces the bundle.
    const runner = fakeRunner({ test: { status: 'passed', output: 'ok' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      runner,
      agent: fakeQaAgent('succeeded'),
    });

    const result = await runVerificationStages(svc, task.id);

    const demo = store.listArtifacts(task.id).find((a) => a.kind === 'demo_evidence');
    expect(demo).toBeDefined();
    const body = store.readArtifactBody(demo!.id);
    // The agent's real bundle, NOT the mock template.
    expect(body).toContain('Video: trace.zip');
    expect(body).not.toContain('(mock)');
    // Both stages green -> advances to self-review.
    expect(result.stage).toBe('agent_self_review');
  });

  it('captures the Playwright video/trace out of the worktree into the demo_evidence', async () => {
    // The QA agent (via the shared harness) records proof into QA_OUTPUT_DIR; the
    // fake writes there when given writeProof. The daemon captures from that dir.
    const runner = fakeRunner({ test: { status: 'passed', output: 'ok' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      runner,
      agent: fakeQaAgent('succeeded', { writeProof: true }),
    });

    await runVerificationStages(svc, task.id);

    const demo = store.listArtifacts(task.id).find((a) => a.kind === 'demo_evidence');
    const body = store.readArtifactBody(demo!.id) ?? '';
    // The body now references the durably-stored assets.
    expect(body).toContain('Captured proof assets');
    expect(body).toContain('demo-assets');
    expect(body).toMatch(/video\.webm/);
    expect(body).toMatch(/trace\.zip/);
    // And the files actually exist in artifact storage (outlive the worktree).
    expect(existsSync(join(artifactsDir, task.id, 'demo-assets', 'video.webm'))).toBe(true);
    expect(existsSync(join(artifactsDir, task.id, 'demo-assets', 'trace.zip'))).toBe(true);
    // Screenshots are captured too, so the review panel can embed them as images.
    expect(existsSync(join(artifactsDir, task.id, 'demo-assets', 'screenshot.png'))).toBe(true);
  });

  it('parks at feature_e2e when the QA agent fails (no false-green demo)', async () => {
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      agent: fakeQaAgent('failed'),
    });

    const result = await runVerificationStages(svc, task.id);

    expect(result.stage).toBe('feature_e2e');
  });

  it('parks at feature_e2e when the QA agent finishes but the verdict is empty/failing', async () => {
    // The agent's turn SUCCEEDS but writes no results.json (zero specs / fabricated
    // pass). The verdict gate must park rather than advance — the core fix.
    const noVerdictAgent: AgentRuntimeAdapter = {
      async runStageAgent(input: AgentRunInput) {
        if (input.stage === 'agent_self_review') {
          return {
            status: 'succeeded' as const,
            transcript: { kind: 'log' as const, title: 'r', body: 'b' },
            produced: [{ kind: 'self_review' as const, title: 'SR', body: 'ok' }],
          };
        }
        // Succeeds + emits a glowing demo_evidence, but NO results.json.
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 'qa', body: 'b' },
          produced: [
            { kind: 'demo_evidence' as const, title: 'Demo', body: 'VERDICT: PASS 8/8 ✓' },
          ],
        };
      },
    };
    const runner = fakeRunner({ test: { status: 'passed', output: 'ok' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      runner,
      agent: noVerdictAgent,
    });

    const result = await runVerificationStages(svc, task.id);

    expect(result.stage).toBe('feature_e2e');
  });

  it('launches the cold self-review from static_checks (self_review lands before E2E)', async () => {
    // #2: past the static gate, static_checks launches the cold self-review so it
    // overlaps feature_e2e. On the claude path the self_review artifact must land
    // during static_checks (the fork), not only at the later agent_self_review stage.
    const runner = fakeRunner({ test: { status: 'passed', output: 'ok' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      runner,
      agent: fakeQaAgent('succeeded'),
    });

    const afterStatic = await svc.runStaticChecks(task.id);

    expect(afterStatic.stage).toBe('feature_e2e');
    const reviews = store.listArtifacts(task.id).filter((a) => a.kind === 'self_review');
    // Exactly one cold review from the fork — not zero, and not a duplicate.
    expect(reviews).toHaveLength(1);
  });

  it('completeSelfReview does NOT run a second cold pass when the fork already produced one', async () => {
    // Idempotency: the static_checks fork produced self_review, so completeSelfReview
    // is a pure transition. A second cold pass would double the review cost (the
    // whole point of running it in the fork was to overlap it with the E2E stage).
    const runner = fakeRunner({ test: { status: 'passed', output: 'ok' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      runner,
      agent: fakeQaAgent('succeeded'),
    });

    await runVerificationStages(svc, task.id); // fork produces self_review, advances to agent_self_review
    const afterFork = store.listArtifacts(task.id).filter((a) => a.kind === 'self_review').length;
    const result = await svc.completeSelfReview(task.id);

    expect(result.stage).toBe('human_review');
    const afterComplete = store
      .listArtifacts(task.id)
      .filter((a) => a.kind === 'self_review').length;
    expect(afterComplete).toBe(afterFork); // no new review produced
  });

  it('runs the QA agent UNGATED (autonomous: Bash auto-approves, no permission deadlock)', async () => {
    // The auto-advance driver runs this with no human at the terminal. The QA
    // agent needs Bash (npm / playwright install / playwright test); a gated run
    // would raise a permission prompt per Bash call that nobody answers. Ungated
    // => the executor passes NO gate to the adapter, so Bash auto-approves.
    // Observe via the gate the adapter receives: undefined means ungated.
    let observedGate: unknown = 'unset';
    const capturing: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('streaming path expected');
      },
      async streamStageAgent(input) {
        observedGate = input.gate;
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [{ kind: 'demo_evidence' as const, title: 'd', body: 'real bundle' }],
        };
      },
    };
    const { task, svc } = setupValidationTask({
      agentRuntime: 'claude',
      agent: capturing,
      // A daemonUrl is what would otherwise wire the permission gate — with it set,
      // a GATED run would hand the adapter a gate. Ungated must still suppress it.
      daemonUrl: 'http://127.0.0.1:9999',
    });

    // The QA agent runs in the feature_e2e stage.
    store.applyTransition(task.id, { stage: 'feature_e2e', status: 'active' });
    await svc.runFeatureE2e(task.id);

    expect(observedGate).toBeUndefined();
  });

  it('runs REAL e2e for a MOCK-runtime project (shell step, no agent)', async () => {
    // Mock runtime keeps the shell-only path: e2eCommand runs for real, no agent.
    const runner = fakeRunner({ e2e: { status: 'passed', output: 'playwright: 2 passed' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'mock',
      e2eCommand: 'playwright test',
      runner,
    });

    await runVerificationStages(svc, task.id);

    const demo = store.listArtifacts(task.id).find((a) => a.kind === 'demo_evidence');
    const body = store.readArtifactBody(demo!.id);
    expect(body).toContain('playwright: 2 passed');
    expect(body).not.toContain('(mock)');
  });

  it('falls back to mock demo_evidence on a mock project with no e2eCommand', async () => {
    const { task, svc } = setupValidationTask({ agentRuntime: 'mock', e2eCommand: '' });

    await runVerificationStages(svc, task.id);

    const demo = store.listArtifacts(task.id).find((a) => a.kind === 'demo_evidence');
    const body = store.readArtifactBody(demo!.id);
    expect(body).toContain('(mock)');
  });

  it('treats a failure that ALSO fails in baseline as pre-existing -> advances', async () => {
    // No distinct worktree here: baseline runs the SAME failing command against
    // the same cwd, so the failure looks pre-existing and must NOT park. (The
    // park-on-NEW-failure case is covered in "Verification baseline comparison".)
    const runner = fakeRunner({ test: { status: 'failed', output: '3 failed' } });
    const { task, svc } = setupValidationTask({
      agentRuntime: 'mock',
      e2eCommand: 'playwright test',
      runner,
    });

    const result = await runVerificationStages(svc, task.id);

    expect(result.stage).toBe('agent_self_review');
  });
});

// ---------------------------------------------------------------------------
// D. Skip Worktree
// ---------------------------------------------------------------------------

describe('worktreeMode', () => {
  it('defaults to "worktree" on new tasks', () => {
    const project = store.createProject({
      name: 'P',
      repoPath: '/fake',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    expect(task.worktreeMode).toBe('worktree');
  });

  it('can be set to "direct" at creation time', () => {
    const project = store.createProject({
      name: 'P',
      repoPath: '/fake',
      defaultBranch: 'main',
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'T',
      rawRequest: 'x',
      worktreeMode: 'direct',
    });
    expect(task.worktreeMode).toBe('direct');
  });

  it('setWorktreeModeOnTask persists "direct" and is readable', () => {
    const project = store.createProject({
      name: 'P',
      repoPath: '/fake',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    store.setWorktreeModeOnTask(task.id, 'direct');
    const updated = store.getTask(task.id);
    expect(updated?.worktreeMode).toBe('direct');
  });

  it('approveBrief with skipWorktree:true sets worktreeMode to direct and creates no worktree', async () => {
    const worktreeCreateSpy = vi.fn().mockResolvedValue({
      worktreePath: '/fake/wt',
      branch: 'wb/task-test',
      baseBranch: 'main',
      status: 'created',
    });
    const mockWorktreeProvider = {
      create: worktreeCreateSpy,
      remove: vi.fn(),
      status: vi.fn(),
      diff: vi.fn(),
    };

    const project = store.createProject({
      name: 'P',
      repoPath: '/fake/repo',
      defaultBranch: 'main',
      agentRuntime: 'mock', // use mock so no real agent calls
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    const svc = new LifecycleService(
      store,
      mockWorktreeProvider as any,
      join(tmpdir(), 'wb-wt-test'),
      undefined,
      undefined,
      fakeRunner({}),
    );

    // Drive to human_brief_approval.
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });

    await svc.approveBrief(task.id, undefined, { skipWorktree: true });

    // No worktree should be created.
    expect(worktreeCreateSpy).not.toHaveBeenCalled();

    // Task should have worktreeMode 'direct'.
    const updated = store.getTask(task.id);
    expect(updated?.worktreeMode).toBe('direct');

    // No worktree row in the store.
    expect(store.getActiveWorktree(task.id)).toBeNull();
  });

  it('approveBrief without skipWorktree creates a worktree (default path unchanged)', async () => {
    // Use the StubWorktreeProvider (default for mock projects) and verify that a
    // worktree row IS created (stub creates an in-memory record) and the task's
    // worktreeMode stays 'worktree'.
    const project = store.createProject({
      name: 'P',
      repoPath: '/fake/repo',
      defaultBranch: 'main',
      agentRuntime: 'mock',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      undefined,
      undefined,
      fakeRunner({}),
    );

    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });

    await svc.approveBrief(task.id);

    // A worktree row should be created (stub provider writes a record).
    expect(store.getActiveWorktree(task.id)).not.toBeNull();

    const updated = store.getTask(task.id);
    expect(updated?.worktreeMode).toBe('worktree');
  });

  it('self-targeting project: approveBrief ignores skipWorktree and still creates a worktree', async () => {
    // Backstop: even if a caller bypasses the API and passes skipWorktree:true, a
    // self-targeting project (repoPath == the daemon's repoRoot) must always get
    // an isolated worktree.
    const selfRepo = '/fake/workbench';
    const project = store.createProject({
      name: 'Self',
      repoPath: selfRepo,
      defaultBranch: 'main',
      agentRuntime: 'mock',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      undefined,
      undefined,
      fakeRunner({}),
      undefined,
      selfRepo, // repoRoot — makes this project self-targeting
    );

    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });

    await svc.approveBrief(task.id, undefined, { skipWorktree: true });

    // The skip was refused: a worktree row exists and the mode stays 'worktree'.
    expect(store.getActiveWorktree(task.id)).not.toBeNull();
    expect(store.getTask(task.id)?.worktreeMode).toBe('worktree');
  });

  it('non-self project still honors skipWorktree (direct mode)', async () => {
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      undefined,
      undefined,
      fakeRunner({}),
      undefined,
      '/fake/workbench', // repoRoot differs from the project repoPath below
    );
    const project = store.createProject({
      name: 'Other',
      repoPath: '/some/other/repo',
      defaultBranch: 'main',
      agentRuntime: 'mock',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });

    await svc.approveBrief(task.id, undefined, { skipWorktree: true });

    expect(store.getActiveWorktree(task.id)).toBeNull();
    expect(store.getTask(task.id)?.worktreeMode).toBe('direct');
  });
});

// ---------------------------------------------------------------------------
// B. Core label
// ---------------------------------------------------------------------------

describe('STAGE_LABELS — Verification split', () => {
  it('static_checks + feature_e2e roll up to one "Verification" group', async () => {
    const { STAGE_LABELS, stageGroupLabel } = await import('@workbench/core');
    // Each sub-step keeps its own precise label...
    expect(STAGE_LABELS['static_checks']).toBe('Static Checks');
    expect(STAGE_LABELS['feature_e2e']).toBe('Project E2E');
    // ...but both share the "Verification" rail GROUP.
    expect(stageGroupLabel('static_checks')).toBe('Verification');
    expect(stageGroupLabel('feature_e2e')).toBe('Verification');
  });
});

// ---------------------------------------------------------------------------
// E. Implementation runs the real agent in auto-advance
// ---------------------------------------------------------------------------

describe('runImplementation (auto-advance)', () => {
  /** A fake claude adapter whose run outcome is controllable. */
  function fakeAgent(status: 'succeeded' | 'failed'): AgentRuntimeAdapter {
    return {
      async runStageAgent(input: AgentRunInput) {
        return {
          status,
          transcript: { kind: 'log' as const, title: `run ${input.stage}`, body: 'fake' },
          produced:
            status === 'succeeded'
              ? [{ kind: 'log' as const, title: `${input.stage}`, body: 'edited files' }]
              : [],
          error: status === 'failed' ? 'agent failed' : undefined,
        };
      },
    };
  }

  function svcWithAgent(status: 'succeeded' | 'failed', runtime: 'mock' | 'claude' = 'claude') {
    const project = store.createProject({
      name: 'P',
      repoPath: process.cwd(),
      defaultBranch: 'main',
      agentRuntime: runtime,
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do x' });
    const svc = new LifecycleService(
      store,
      new StubWorktreeProvider(),
      join(tmpdir(), 'wb-wt-test'),
      () => fakeAgent(status),
      undefined,
      fakeRunner({}),
    );
    store.applyTransition(task.id, { stage: 'implementation', status: 'active' });
    return { task, svc };
  }

  it('advances past implementation when the claude agent succeeds', async () => {
    const { task, svc } = svcWithAgent('succeeded');
    const result = await svc.runImplementation(task.id);
    expect(result.stage).toBe('static_checks');
  });

  it('PARKS at implementation when the claude agent fails (no false-green validation)', async () => {
    const { task, svc } = svcWithAgent('failed');
    const result = await svc.runImplementation(task.id);
    expect(result.stage).toBe('implementation');
    expect(result.status).toBe('active');
  });

  it('mock-runtime projects keep the no-op transition (no agent run)', async () => {
    const { task, svc } = svcWithAgent('failed', 'mock');
    // Even with a "failing" agent injected, a mock project never runs it and
    // advances via the plain transition.
    const result = await svc.runImplementation(task.id);
    expect(result.stage).toBe('static_checks');
  });
});
