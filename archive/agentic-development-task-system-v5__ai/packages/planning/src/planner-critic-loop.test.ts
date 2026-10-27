import { describe, expect, it } from 'vitest';
import { runPlannerCriticLoop, allowedToolsForRole } from './planner-critic-loop.js';
import { draftPlan } from './plan.js';
import type { Finding, ImplementationPlan } from '@awb/domain';

function makePlan(version: number): ImplementationPlan {
  return draftPlan({ taskId: 'task-1', contractVersion: 1, summary: `v${version}`, slices: [] }, [], version);
}

const blockerFinding: Finding = {
  id: 'f1',
  taskId: 'task-1',
  severity: 'blocker',
  category: 'architecture',
  claimIds: [],
  description: 'plan does not account for X',
  status: 'open',
};

describe('runPlannerCriticLoop', () => {
  it('accepts on the first attempt when the critic has no blocker/high findings', async () => {
    const result = await runPlannerCriticLoop({
      taskId: 'task-1',
      cwd: '/tmp',
      contextPayload: {},
      runPlanner: async () => makePlan(1),
      runCritic: async () => [],
    });
    expect(result.outcome).toBe('accepted');
    expect(result.attempts).toBe(1);
  });

  it('loops back to the planner after a blocker finding, then accepts', async () => {
    let planCalls = 0;
    let criticCalls = 0;
    const result = await runPlannerCriticLoop({
      taskId: 'task-1',
      cwd: '/tmp',
      contextPayload: {},
      runPlanner: async (priorFindings) => {
        planCalls += 1;
        if (planCalls === 1) {
          expect(priorFindings).toEqual([]);
        } else {
          expect(priorFindings).toEqual([blockerFinding]);
        }
        return makePlan(planCalls);
      },
      runCritic: async () => {
        criticCalls += 1;
        return criticCalls === 1 ? [blockerFinding] : [];
      },
    });
    expect(result.outcome).toBe('accepted');
    expect(planCalls).toBe(2);
  });

  it('reports non-convergent after maxAttempts without acceptance', async () => {
    const result = await runPlannerCriticLoop({
      taskId: 'task-1',
      cwd: '/tmp',
      contextPayload: {},
      maxAttempts: 2,
      runPlanner: async () => makePlan(1),
      runCritic: async () => [blockerFinding],
    });
    expect(result.outcome).toBe('non-convergent');
    if (result.outcome === 'non-convergent') {
      expect(result.attempts).toBe(2);
      expect(result.lastFindings).toEqual([blockerFinding]);
    }
  });

  it('a medium-severity finding does not block acceptance', async () => {
    const mediumFinding: Finding = { ...blockerFinding, severity: 'medium' };
    const result = await runPlannerCriticLoop({
      taskId: 'task-1',
      cwd: '/tmp',
      contextPayload: {},
      runPlanner: async () => makePlan(1),
      runCritic: async () => [mediumFinding],
    });
    expect(result.outcome).toBe('accepted');
  });
});

describe('allowedToolsForRole', () => {
  it('returns read-only capabilities for the planner', () => {
    const tools = allowedToolsForRole('planner');
    expect(tools).toContain('repository.read');
    expect(tools).not.toContain('worktree.write');
  });

  it('returns finding.write plus read-only capabilities for the plan-critic', () => {
    const tools = allowedToolsForRole('plan-critic');
    expect(tools).toContain('finding.write');
    expect(tools).not.toContain('command.run-scoped');
  });
});
