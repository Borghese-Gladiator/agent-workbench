import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter } from '@workbench/agents';
import { Store } from '@workbench/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleService } from './service.js';

/**
 * The lifecycle stage transitions (brief, plan, etc.) must produce REAL agent
 * output for `claude` projects — not the `(mock)` template prose that used to
 * leak in regardless of runtime. These tests capture the AgentRunInput the
 * adapter receives and assert the stored artifact is the adapter's output and
 * that reviewer feedback reaches the adapter on regeneration.
 */

let store: Store;
let artifactsDir: string;
let repoDir: string;
const inputs: AgentRunInput[] = [];

/** Adapter that records each run input and returns identifiable real output. */
function capturingAdapter(sessionId?: string): AgentRuntimeAdapter {
  return {
    async runStageAgent(input: AgentRunInput) {
      inputs.push(input);
      return {
        status: 'succeeded' as const,
        transcript: { kind: 'log' as const, title: 'run', body: 'transcript body' },
        produced: [
          {
            kind: 'task_brief' as const,
            title: `${input.stage} (claude)`,
            body: `REAL agent output for ${input.stage}`,
          },
        ],
        // Echo a session id so the daemon persists it and a later reject can
        // `--resume` it. Undefined by default (mirrors a run with no session).
        sessionId,
      };
    },
  };
}

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-route-'));
  store = new Store({ dbPath: ':memory:', artifactsDir });
  repoDir = mkdtempSync(join(tmpdir(), 'wb-route-repo-'));
  // Seed real source so the repo is NOT treated as a brand-new/empty checkout —
  // otherwise Discovery short-circuits and skips the agent run (see the dedicated
  // empty-repo test below).
  writeFileSync(join(repoDir, 'index.ts'), 'export const x = 1;\n');
  inputs.length = 0;
});
afterEach(() => {
  store.close();
  rmSync(artifactsDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function service(
  runtime: 'claude' | 'mock',
  sessionId?: string,
): { svc: LifecycleService; taskId: string } {
  const svc = new LifecycleService(store, undefined, undefined, () => capturingAdapter(sessionId));
  const project = store.createProject({
    name: 'P',
    repoPath: repoDir,
    defaultBranch: 'main',
    agentRuntime: runtime,
  });
  const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });
  return { svc, taskId: task.id };
}

function briefBody(taskId: string): string {
  const brief = store.listArtifacts(taskId).find((a) => a.kind === 'task_brief');
  if (!brief) throw new Error('no task_brief artifact');
  return store.readArtifactBody(brief.id) ?? '';
}

describe('lifecycle stage routing — claude runtime', () => {
  it('produces real agent output for the brief, not mock template prose', async () => {
    const { svc, taskId } = service('claude');
    await svc.generateBrief(taskId);

    expect(inputs.map((i) => i.stage)).toContain('task_brief');
    const body = briefBody(taskId);
    expect(body).toContain('REAL agent output for task_brief');
    expect(body).not.toContain('(mock)');
  });

  it('grounds the brief in the project repo when no worktree exists yet', async () => {
    const { svc, taskId } = service('claude');
    await svc.generateBrief(taskId);
    const briefRun = inputs.find((i) => i.stage === 'task_brief');
    expect(briefRun?.worktreePath).toBe(repoDir);
  });

  it('reject-brief resumes the brief session with ONLY the comment, parking at the gate', async () => {
    const { svc, taskId } = service('claude', 'sess_brief');
    await svc.generateBrief(taskId); // -> human_brief_approval (captures sess_brief)
    inputs.length = 0;

    const task = await svc.rejectBrief(taskId, 'Please cover the error case.');

    // One motion: a revised brief is produced and we are back at the gate.
    expect(task.stage).toBe('human_brief_approval');
    const regen = inputs.find((i) => i.stage === 'task_brief');
    // Resumes the brief's own session, sending JUST the reviewer's comment — not
    // a fresh stage packet with feedback appended.
    expect(regen?.resume).toEqual({
      sessionId: 'sess_brief',
      message: 'Please cover the error case.',
    });
    expect(regen?.reviewerFeedback).toBeUndefined();
    // Two brief artifacts now exist (V1 + the revision).
    expect(store.listArtifacts(taskId).filter((a) => a.kind === 'task_brief')).toHaveLength(2);
  });

  it('reject-brief without a captured session falls back to threaded feedback', async () => {
    const { svc, taskId } = service('claude'); // adapter returns no sessionId
    await svc.generateBrief(taskId);
    inputs.length = 0;

    const task = await svc.rejectBrief(taskId, 'Please cover the error case.');

    expect(task.stage).toBe('human_brief_approval');
    const regen = inputs.find((i) => i.stage === 'task_brief');
    expect(regen?.resume).toBeUndefined();
    expect(regen?.reviewerFeedback).toBe('Please cover the error case.');
  });

  it('reject-brief falls back to a fresh full-context redo when the resume fails', async () => {
    // Adapter that captures inputs, returns a session id on a fresh run, but
    // FAILS any run that tries to --resume (simulating an aged-out session).
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent(input: AgentRunInput) {
        inputs.push(input);
        if (input.resume) {
          return {
            status: 'failed' as const,
            transcript: { kind: 'log' as const, title: 'run', body: 'resume failed' },
            produced: [],
            error: 'no conversation found with session id',
          };
        }
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 'run', body: 'transcript' },
          produced: [{ kind: 'task_brief' as const, title: 'brief', body: 'fresh brief' }],
          sessionId: 'sess_brief',
        };
      },
    };
    const svc = new LifecycleService(store, undefined, undefined, () => adapter);
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });
    await svc.generateBrief(task.id); // captures sess_brief
    inputs.length = 0;

    const after = await svc.rejectBrief(task.id, 'Please cover the error case.');

    // It tried resume first (failed), then redid from scratch — and still parks
    // at the gate with a brief, rather than surfacing the resume failure.
    expect(after.stage).toBe('human_brief_approval');
    expect(inputs[0]!.resume).toEqual({
      sessionId: 'sess_brief',
      message: 'Please cover the error case.',
    });
    const fresh = inputs[1]!;
    expect(fresh.resume).toBeUndefined();
    // The fresh redo carries full context AND the emphasized comment.
    expect(fresh.contextArtifactIds.length).toBeGreaterThan(0);
    expect(fresh.reviewerFeedback).toContain('REJECTED');
    expect(fresh.reviewerFeedback).toContain('Please cover the error case.');
    // A brief artifact exists from the successful fresh redo.
    expect(store.listArtifacts(task.id).filter((a) => a.kind === 'task_brief')).toHaveLength(2);
  });
});

describe('brief derives a real title for placeholder titles', () => {
  /** Adapter whose brief body ends with a json block carrying `title`. */
  function titleAdapter(title: string): AgentRuntimeAdapter {
    return {
      async runStageAgent(input: AgentRunInput) {
        inputs.push(input);
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 'run', body: 't' },
          produced: [
            {
              kind: 'task_brief' as const,
              title: 'brief',
              body: `# Brief\n\n\`\`\`json\n${JSON.stringify({ title })}\n\`\`\`\n`,
            },
          ],
        };
      },
    };
  }

  function serviceWith(adapter: AgentRuntimeAdapter, title: string) {
    const svc = new LifecycleService(store, undefined, undefined, () => adapter);
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title, rawRequest: 'do a thing' });
    return { svc, taskId: task.id };
  }

  it('asks for a title and renames the task when the title is a placeholder', async () => {
    const { svc, taskId } = serviceWith(
      titleAdapter('Add CSV export to the campaigns report'),
      'Linear Ticket',
    );

    await svc.generateBrief(taskId);

    expect(inputs.find((i) => i.stage === 'task_brief')?.deriveTitle).toBe(true);
    expect(store.getTask(taskId)!.title).toBe('Add CSV export to the campaigns report');
  });

  it('does NOT ask or rename when the human already gave a real title', async () => {
    const { svc, taskId } = serviceWith(
      titleAdapter('Some agent-suggested name'),
      'Add a dark mode toggle',
    );

    await svc.generateBrief(taskId);

    expect(inputs.find((i) => i.stage === 'task_brief')?.deriveTitle).toBe(false);
    // A real human title is never overwritten by the agent's suggestion.
    expect(store.getTask(taskId)!.title).toBe('Add a dark mode toggle');
  });

  it('keeps the placeholder when the agent emits no usable title', async () => {
    // Brief with a json block but a still-generic title -> no rename.
    const { svc, taskId } = serviceWith(titleAdapter('Linear Ticket'), 'Linear Ticket');

    await svc.generateBrief(taskId);

    expect(store.getTask(taskId)!.title).toBe('Linear Ticket');
  });
});

describe('implementation bounce — resume the prior session', () => {
  /**
   * Seed a task parked at `implementation` after a human_review bounce: a prior
   * succeeded implementation run captured `sessionId`, and the reviewer left a
   * bounce comment. This is the exact state `runImplementation` sees on a redo.
   */
  function seedBounce(svc: LifecycleService, taskId: string, sessionId: string, comment: string) {
    const run = store.createAgentRun({ taskId, stage: 'implementation' });
    store.updateAgentRun(run.id, { status: 'succeeded', sessionId });
    store.recordApproval({ taskId, gate: 'human_review', decision: 'bounce', comment });
    store.applyTransition(taskId, { stage: 'implementation', status: 'active' });
  }

  it('resumes the implementation session with ONLY the bounce comment', async () => {
    const { svc, taskId } = service('claude', 'sess_impl2');
    seedBounce(svc, taskId, 'sess_impl', 'Scope the ORM lookups to company_id.');
    inputs.length = 0;

    await svc.runImplementation(taskId);

    const redo = inputs.find((i) => i.stage === 'implementation');
    // Resumes the prior session, sending JUST the reviewer's comment — not a
    // fresh stage packet with feedback appended (mirrors the brief path).
    expect(redo?.resume).toEqual({
      sessionId: 'sess_impl',
      message: 'Scope the ORM lookups to company_id.',
    });
    expect(redo?.reviewerFeedback).toBeUndefined();
    // It advanced past implementation (the redo succeeded).
    expect(store.getTask(taskId)!.stage).not.toBe('implementation');
  });

  it('cold-starts the first build (no prior session, no bounce feedback)', async () => {
    const { svc, taskId } = service('claude', 'sess_impl');
    store.applyTransition(taskId, { stage: 'implementation', status: 'active' });
    inputs.length = 0;

    await svc.runImplementation(taskId);

    const run = inputs.find((i) => i.stage === 'implementation');
    expect(run?.resume).toBeUndefined();
    // A first build has no reviewer feedback to thread either.
    expect(run?.reviewerFeedback).toBeUndefined();
  });

  it('does not resume when there is a session but no bounce comment', async () => {
    const { svc, taskId } = service('claude', 'sess_impl2');
    const run = store.createAgentRun({ taskId, stage: 'implementation' });
    store.updateAgentRun(run.id, { status: 'succeeded', sessionId: 'sess_impl' });
    // A bounce with NO comment leaves nothing to continue the session with.
    store.recordApproval({ taskId, gate: 'human_review', decision: 'bounce', comment: null });
    store.applyTransition(taskId, { stage: 'implementation', status: 'active' });
    inputs.length = 0;

    await svc.runImplementation(taskId);

    expect(inputs.find((i) => i.stage === 'implementation')?.resume).toBeUndefined();
  });

  it('falls back to a fresh cold run when the resume fails', async () => {
    // Adapter that captures inputs, succeeds a cold run, but FAILS any --resume
    // (simulating an aged-out session).
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent(input: AgentRunInput) {
        inputs.push(input);
        if (input.resume) {
          return {
            status: 'failed' as const,
            transcript: { kind: 'log' as const, title: 'run', body: 'resume failed' },
            produced: [],
            error: 'no conversation found with session id',
          };
        }
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 'run', body: 'transcript' },
          produced: [{ kind: 'implementation' as const, title: 'impl', body: 'cold redo' }],
          sessionId: 'sess_impl2',
        };
      },
    };
    const svc = new LifecycleService(store, undefined, undefined, () => adapter);
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });
    seedBounce(svc, task.id, 'sess_impl', 'Scope the ORM lookups to company_id.');
    inputs.length = 0;

    await svc.runImplementation(task.id);

    // It tried resume first (failed), then redid cold — and still advanced.
    expect(inputs[0]!.resume).toEqual({
      sessionId: 'sess_impl',
      message: 'Scope the ORM lookups to company_id.',
    });
    const cold = inputs[1]!;
    expect(cold.resume).toBeUndefined();
    // The cold redo threads the bounce comment in as reviewer feedback.
    expect(cold.reviewerFeedback).toBe('Scope the ORM lookups to company_id.');
    expect(store.getTask(task.id)!.stage).not.toBe('implementation');
  });

  it('mock projects keep the no-op transition (no agent, no resume)', async () => {
    const { svc, taskId } = service('mock');
    store.applyTransition(taskId, { stage: 'implementation', status: 'active' });
    inputs.length = 0;

    await svc.runImplementation(taskId);

    expect(inputs).toHaveLength(0);
  });
});

describe('self-review re-review — scoped to prior findings after a bounce', () => {
  it('runs a full-scope (no-feedback) pass on the FIRST self-review', async () => {
    const { svc, taskId } = service('claude');
    store.applyTransition(taskId, { stage: 'agent_self_review', status: 'active' });
    inputs.length = 0;

    await svc.completeSelfReview(taskId);

    const run = inputs.find((i) => i.stage === 'agent_self_review');
    // No prior self-review exists yet -> cold, full-scope adversarial pass.
    expect(run?.reviewerFeedback).toBeUndefined();
  });

  it('threads prior findings + the bounce comment into the RE-review', async () => {
    const { svc, taskId } = service('claude');
    // A prior self-review already ran, and the human bounced with a comment.
    store.createArtifact({
      taskId,
      stageRunId: null,
      kind: 'self_review',
      title: 'self-review v1',
      body: '### Findings\n- Blocking: null deref in foo()',
    });
    store.recordApproval({
      taskId,
      gate: 'human_review',
      decision: 'bounce',
      comment: 'Fix the null deref, ignore the naming nits.',
    });
    store.applyTransition(taskId, { stage: 'agent_self_review', status: 'active' });
    inputs.length = 0;

    await svc.completeSelfReview(taskId);

    const run = inputs.find((i) => i.stage === 'agent_self_review');
    // The re-review carries the prior findings AND the bounce comment so it can
    // verify resolution instead of re-reviewing from scratch.
    expect(run?.reviewerFeedback).toContain('null deref in foo()');
    expect(run?.reviewerFeedback).toContain('Fix the null deref, ignore the naming nits.');
  });
});

describe('lifecycle stage routing — mock runtime (unchanged)', () => {
  it('still produces deterministic mock content and never invokes the adapter', async () => {
    const { svc, taskId } = service('mock');
    await svc.generateBrief(taskId);

    expect(inputs).toHaveLength(0);
    expect(briefBody(taskId)).toContain('(mock)');
  });
});

describe('resume — recovery for tasks parked at auto-advanceable stages', () => {
  it('re-enters the driver and advances the parked task to the next gate', async () => {
    const { svc, taskId } = service('claude');
    // Simulate a daemon restart that killed the driving POST mid-advance:
    // the task sits at discovery with no run in flight.
    store.applyTransition(taskId, { stage: 'discovery', status: 'active' });

    const task = await svc.resume(taskId);

    expect(task.stage).toBe('human_plan_approval');
    // Discovery + planning are one stage now — a single agent run reaches the gate.
    expect(inputs.map((i) => i.stage)).toEqual(expect.arrayContaining(['discovery']));
    expect(store.listAgentRuns(taskId).every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('409s while a run is already in flight', async () => {
    const { svc, taskId } = service('claude');
    store.applyTransition(taskId, { stage: 'discovery', status: 'active' });
    store.createAgentRun({ taskId, stage: 'discovery' }); // simulated live run

    await expect(svc.resume(taskId)).rejects.toMatchObject({ status: 409 });
  });
});

describe('discovery — brand-new / empty repo short-circuit', () => {
  it('skips the discovery agent run and advances when the repo has no code', async () => {
    // A fresh checkout with only boilerplate: nothing to explore.
    const emptyRepo = mkdtempSync(join(tmpdir(), 'wb-empty-repo-'));
    writeFileSync(join(emptyRepo, 'README.md'), '# new\n');
    try {
      const svc = new LifecycleService(store, undefined, undefined, () => capturingAdapter());
      const project = store.createProject({
        name: 'P',
        repoPath: emptyRepo,
        defaultBranch: 'main',
        agentRuntime: 'claude',
      });
      const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'build it' });
      store.applyTransition(task.id, { stage: 'discovery', status: 'active' });

      await svc.createDiscovery(task.id);

      // No agent run for discovery — it was skipped programmatically.
      expect(inputs.map((i) => i.stage)).not.toContain('discovery');
      // A deterministic execution_plan artifact was still written, and we advanced
      // straight to the plan gate (discovery + planning are one stage).
      const plan = store.listArtifacts(task.id).find((a) => a.kind === 'execution_plan');
      expect(plan).toBeDefined();
      expect(plan!.title).toContain('empty');
      expect(store.getTask(task.id)!.stage).toBe('human_plan_approval');
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('still runs the discovery agent when the repo has real code', async () => {
    // repoDir is seeded with index.ts in beforeEach.
    const { svc, taskId } = service('claude');
    store.applyTransition(taskId, { stage: 'discovery', status: 'active' });

    await svc.createDiscovery(taskId);

    expect(inputs.map((i) => i.stage)).toContain('discovery');
  });
});

describe('stage context handoff — prior-artifact BODIES are threaded', () => {
  /** Adapter that produces the stage's NATURAL artifact kind, so each stage's
   *  output is a distinct, addressable artifact (brief/plan). The merged
   *  discovery stage produces the execution_plan. */
  function stageKindAdapter(): AgentRuntimeAdapter {
    const KIND: Record<string, 'task_brief' | 'discovery' | 'execution_plan'> = {
      task_brief: 'task_brief',
      discovery: 'execution_plan',
    };
    return {
      async runStageAgent(input: AgentRunInput) {
        inputs.push(input);
        const kind = KIND[input.stage] ?? 'task_brief';
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 'run', body: 't' },
          produced: [{ kind, title: `${input.stage} out`, body: `BODY of ${input.stage}` }],
        };
      },
    };
  }

  it('the merged discovery+plan stage receives the task_brief BODY', async () => {
    const svc = new LifecycleService(store, undefined, undefined, () => stageKindAdapter());
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir, // seeded with index.ts -> not an empty repo
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });

    // Brief, then approve (creates the worktree + drives the merged stage -> gate).
    await svc.generateBrief(task.id);
    await svc.approveBrief(task.id);

    const discovery = inputs.find((i) => i.stage === 'discovery');

    // Discovery + planning are one stage: it reads the brief and produces the plan
    // in a single run, so there is no second planning input to thread discovery into.
    expect(discovery?.contextArtifacts?.map((a) => a.kind)).toEqual(['task_brief']);
    expect(discovery?.contextArtifacts?.[0]?.body).toBe('BODY of task_brief');
    expect(inputs.filter((i) => i.stage === 'discovery')).toHaveLength(1);
  });

  it('threads the LATEST body when a kind has multiple artifacts (re-runs)', async () => {
    const svc = new LifecycleService(store, undefined, undefined, () => stageKindAdapter());
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });
    // An OLD brief that a regeneration supersedes.
    store.createArtifact({
      taskId: task.id,
      stageRunId: null,
      kind: 'task_brief',
      title: 'stale brief',
      body: 'STALE brief body',
    });

    await svc.generateBrief(task.id); // writes the current brief
    store.applyTransition(task.id, { stage: 'discovery', status: 'active' });
    inputs.length = 0;
    await svc.createDiscovery(task.id);

    const discovery = inputs.find((i) => i.stage === 'discovery');
    // The freshest brief wins — not the stale one seeded first.
    expect(discovery?.contextArtifacts?.[0]?.body).toBe('BODY of task_brief');
  });
});

describe('plan rejection resumes the planning session', () => {
  // The crux of the "agent created N artifacts" bug: a stage re-entry used to
  // COLD-PROMPT a fresh Claude session (re-derive everything, write a new artifact
  // set) instead of RESUMING the prior session and revising in-context. The plan
  // stage was the live offender — it threaded the rejection comment but never
  // resumed. These mirror the reject-brief resume tests for the plan stage.
  async function driveToPlanGate(sessionId?: string) {
    const { svc, taskId } = service('claude', sessionId);
    await svc.generateBrief(taskId);
    // Approve the brief; auto-advance runs discovery -> baseline -> plan and parks
    // at the human plan gate (the plan run captures the session id).
    await svc.approveBrief(taskId, undefined, { skipWorktree: true });
    expect(store.getTask(taskId)!.stage).toBe('human_plan_approval');
    inputs.length = 0;
    return { svc, taskId };
  }

  it('reject-plan resumes the plan session with ONLY the comment', async () => {
    const { svc, taskId } = await driveToPlanGate('sess_plan');

    await svc.rejectPlan(taskId, 'Add a rollback step.');

    const regen = inputs.find((i) => i.stage === 'discovery');
    // Resumes the planning session, sending JUST the reviewer's comment — not a
    // fresh stage packet that re-derives the whole plan.
    expect(regen?.resume).toEqual({ sessionId: 'sess_plan', message: 'Add a rollback step.' });
    expect(regen?.reviewerFeedback).toBeUndefined();
  });

  it('reject-plan without a captured session falls back to threaded feedback', async () => {
    // Adapter returns no sessionId -> nothing to resume.
    const { svc, taskId } = await driveToPlanGate();

    await svc.rejectPlan(taskId, 'Add a rollback step.');

    const regen = inputs.find((i) => i.stage === 'discovery');
    expect(regen?.resume).toBeUndefined();
    expect(regen?.reviewerFeedback).toBe('Add a rollback step.');
  });

  it('a human-review BOUNCE back to the plan stage also resumes the plan session', async () => {
    // A bounce-to-plan is recorded under the human_review/bounce gate, NOT the
    // plan-rejection gate — so the plan stage must source its re-entry comment
    // from both, or a bounce would cold-prompt. (Mirrors q1's implementation
    // bounce, closing the symmetric hole on the plan side.)
    const { svc, taskId } = await driveToPlanGate('sess_plan');
    // Simulate the bounce: record the human_review bounce decision and re-enter
    // the plan stage, exactly as humanReviewBounce(target='discovery') does.
    store.recordApproval({
      taskId,
      gate: 'human_review',
      decision: 'bounce',
      comment: 'Rework the rollout ordering.',
    });
    store.applyTransition(taskId, { stage: 'discovery', status: 'active' });

    await svc.createDiscovery(taskId);

    const regen = inputs.find((i) => i.stage === 'discovery');
    expect(regen?.resume).toEqual({
      sessionId: 'sess_plan',
      message: 'Rework the rollout ordering.',
    });
    expect(regen?.reviewerFeedback).toBeUndefined();
  });
});

describe('lifecycle runs stream through the executor', () => {
  it('records an AgentRun whose event log ends with a terminal result', async () => {
    const { svc, taskId } = service('claude');
    await svc.generateBrief(taskId);

    const runs = store.listAgentRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.stage).toBe('task_brief');
    expect(runs[0]!.status).toBe('succeeded');
    // The one-shot fallback emits no events, so the executor must synthesize
    // the terminal `result` — SSE clients rely on it to know the run is over.
    const events = store.listAgentRunEvents(runs[0]!.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.type).toBe('result');
  });

  it("persists a streaming adapter's events for the lifecycle-triggered run", async () => {
    const streaming: AgentRuntimeAdapter = {
      ...capturingAdapter(),
      async streamStageAgent(input, handlers) {
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'thinking…' } });
        handlers.onEvent({ type: 'tool_call', payload: { name: 'Read', input: {} } });
        handlers.onEvent({
          type: 'result',
          payload: { subtype: 'success', isError: false, denials: [] },
        });
        return this.runStageAgent(input);
      },
    };
    const svc = new LifecycleService(store, undefined, undefined, () => streaming);
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });
    await svc.generateBrief(task.id);

    const runs = store.listAgentRuns(task.id);
    expect(runs).toHaveLength(1);
    const types = store.listAgentRunEvents(runs[0]!.id).map((e) => e.type);
    expect(types).toEqual(['assistant_text', 'tool_call', 'result']);
  });

  it('502s on a failed run, marks it failed, and still persists the transcript', async () => {
    const failing: AgentRuntimeAdapter = {
      async runStageAgent() {
        return {
          status: 'failed' as const,
          transcript: { kind: 'log' as const, title: 'run', body: 'failure transcript' },
          produced: [],
          error: 'boom',
        };
      },
    };
    const svc = new LifecycleService(store, undefined, undefined, () => failing);
    const project = store.createProject({
      name: 'P',
      repoPath: repoDir,
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do a thing' });

    await expect(svc.generateBrief(task.id)).rejects.toMatchObject({ status: 502 });

    const run = store.listAgentRuns(task.id)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('boom');
    const types = store.listAgentRunEvents(run.id).map((e) => e.type);
    expect(types).toContain('error');
    const log = store.listArtifacts(task.id).find((a) => a.kind === 'log');
    expect(log).toBeDefined();
    expect(store.readArtifactBody(log!.id)).toBe('failure transcript');
  });
});
