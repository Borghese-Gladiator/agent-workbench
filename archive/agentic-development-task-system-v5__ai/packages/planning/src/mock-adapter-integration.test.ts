import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '@awb/agent-gateway';
import { runPlannerCriticLoop, allowedToolsForRole, NOOP_EVENT_SINK } from './planner-critic-loop.js';
import { draftPlan } from './plan.js';
import type { Finding } from '@awb/domain';

describe('planner-critic loop wired to the real MockAgentAdapter', () => {
  it('drives a full planner <-> critic exchange through real createSession/execute calls', async () => {
    const adapter = new MockAgentAdapter();
    const taskId = 'task-integration-1';

    const blockerFinding: Finding = {
      id: 'f1',
      taskId,
      severity: 'blocker',
      category: 'architecture',
      claimIds: [],
      description: 'plan is missing a rollback strategy',
      status: 'open',
    };

    // First critic pass rejects; second accepts.
    adapter.scriptTurns(taskId, 'plan-critic', { findings: [blockerFinding] }, { findings: [] });
    adapter.scriptTurns(taskId, 'planner', { summary: 'draft v1' }, { summary: 'draft v2 addressing rollback' });

    let plannerAttempt = 0;
    const result = await runPlannerCriticLoop({
      taskId,
      cwd: '/tmp/worktree',
      contextPayload: { objective: 'add a feature flag' },
      runPlanner: async (priorFindings) => {
        plannerAttempt += 1;
        const session = await adapter.createSession({
          role: 'planner',
          taskId,
          cwd: '/tmp/worktree',
          contextPayload: { priorFindings },
          allowedTools: allowedToolsForRole('planner'),
        });
        const executionResult = await adapter.execute(
          session,
          { instruction: 'produce an implementation plan' },
          NOOP_EVENT_SINK,
          new AbortController().signal,
        );
        expect(executionResult.completed).toBe(true);
        return draftPlan(
          { taskId, contractVersion: 1, summary: executionResult.summary, slices: [] },
          [],
          plannerAttempt,
        );
      },
      runCritic: async (plan) => {
        const session = await adapter.createSession({
          role: 'plan-critic',
          taskId,
          cwd: '/tmp/worktree',
          contextPayload: { plan },
          allowedTools: allowedToolsForRole('plan-critic'),
        });
        const executionResult = await adapter.execute(
          session,
          { instruction: 'critique the plan' },
          NOOP_EVENT_SINK,
          new AbortController().signal,
        );
        return executionResult.findings;
      },
    });

    expect(result.outcome).toBe('accepted');
    expect(plannerAttempt).toBe(2);
    if (result.outcome === 'accepted') {
      expect(result.plan.summary).toBe('draft v2 addressing rollback');
    }
  });
});
