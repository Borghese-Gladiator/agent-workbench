import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '@awb/agent-gateway';
import type { Finding, ImplementationPlan, TaskContract } from '@awb/domain';
import { allowedToolsForRole, runAdversarialReview } from './review-runner.js';
import type { ReviewInputs } from './review-inputs.js';

describe('adversarial-review runner wired to the real MockAgentAdapter', () => {
  it('drives a real createSession/execute call and returns the scripted findings', async () => {
    const adapter = new MockAgentAdapter();
    const taskId = 'task-review-integration-1';
    const cwd = '/tmp/worktree-readonly-view';

    const taskContract: TaskContract = {
      id: 'contract-1',
      taskId,
      version: 1,
      objective: 'add currency conversion to reports',
      problemStatement: 'reports do not support currency conversion',
      constraints: [],
      nonGoals: [],
      risk: 'medium',
      claims: [],
      status: 'approved',
    };

    const plan: ImplementationPlan = {
      id: 'plan-1',
      taskId,
      contractVersion: 1,
      version: 1,
      summary: 'add a conversion step in the report pipeline',
      affectedAreas: ['reports'],
      slices: [],
      risks: [],
      claimCoverage: [],
      status: 'accepted',
    };

    const reviewInputs: ReviewInputs = {
      taskContract,
      plan,
      finalDiff: 'diff --git a/src/reports/query.ts b/src/reports/query.ts\n+ convert(amount)',
      relevantSourcePaths: ['src/reports/query.ts'],
      testPaths: ['src/reports/query.test.ts'],
      verificationEvidenceIds: ['ev-verify-1'],
      qaEvidenceIds: ['ev-qa-1'],
      repositoryInvariants: ['reports must not perform currency math outside query.ts'],
    };

    const dataIntegrityFinding: Finding = {
      id: 'finding-1',
      taskId,
      severity: 'high',
      category: 'data-integrity',
      claimIds: [],
      path: 'src/reports/query.ts',
      description: 'conversion uses a stale exchange rate cached at process start',
      status: 'open',
    };

    adapter.scriptTurns(taskId, 'adversarial-reviewer', {
      findings: [dataIntegrityFinding],
      summary: 'found one high-severity data-integrity issue',
    });

    const result = await runAdversarialReview({
      taskId,
      cwd,
      reviewInputs,
      runReviewer: async (inputs) => {
        const session = await adapter.createSession({
          role: 'adversarial-reviewer',
          taskId,
          cwd,
          contextPayload: inputs,
          allowedTools: allowedToolsForRole(),
        });
        const executionResult = await adapter.execute(
          session,
          { instruction: 'adversarially review the final diff against the contract and plan' },
          () => {},
          new AbortController().signal,
        );
        return {
          reviewerSessionId: session.id,
          completed: executionResult.completed,
          findings: executionResult.findings,
          summary: executionResult.summary,
        };
      },
    });

    expect(result.completed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('data-integrity');
    expect(result.summary).toBe('found one high-severity data-integrity issue');
    expect(result.reviewerSessionId).toBeTruthy();
  });
});
