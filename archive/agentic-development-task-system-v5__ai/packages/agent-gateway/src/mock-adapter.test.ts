import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from './mock-adapter.js';
import type { AgentEvent } from '@awb/domain';

async function makeSession(adapter: MockAgentAdapter, taskId: string, role: 'planner' | 'plan-critic' | 'builder' | 'verifier' | 'qa-executor' | 'adversarial-reviewer') {
  return adapter.createSession({
    role,
    taskId,
    cwd: '/tmp/worktree',
    contextPayload: {},
    allowedTools: [],
  });
}

describe('MockAgentAdapter', () => {
  it('simulates successful planning', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'planner', { summary: 'plan produced' });
    const session = await makeSession(adapter, 'task-1', 'planner');
    const events: AgentEvent[] = [];
    const result = await adapter.execute(
      session,
      { instruction: 'plan the feature' },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result.completed).toBe(true);
    expect(result.summary).toBe('plan produced');
  });

  it('simulates critic rejection via findings', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'plan-critic', {
      findings: [
        {
          id: 'f1',
          taskId: 'task-1',
          severity: 'blocker',
          category: 'requirements',
          claimIds: [],
          description: 'plan does not cover claim X',
          status: 'open',
        },
      ],
    });
    const session = await makeSession(adapter, 'task-1', 'plan-critic');
    const result = await adapter.execute(session, { instruction: 'critique the plan' }, () => {}, new AbortController().signal);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('blocker');
  });

  it('simulates source edits via file-changed events', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', {
      events: [
        { type: 'file-changed', path: 'src/foo.ts' },
        { type: 'file-changed', path: 'src/foo.test.ts' },
      ],
    });
    const session = await makeSession(adapter, 'task-1', 'builder');
    const events: AgentEvent[] = [];
    await adapter.execute(session, { instruction: 'implement slice' }, (e) => events.push(e), new AbortController().signal);
    expect(events.filter((e) => e.type === 'file-changed')).toHaveLength(2);
  });

  it('simulates test failures via command-completed with non-zero exit', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', {
      events: [{ type: 'command-completed', commandId: 'cmd-1', exitCode: 1 }],
    });
    const session = await makeSession(adapter, 'task-1', 'builder');
    const events: AgentEvent[] = [];
    await adapter.execute(session, { instruction: 'run tests' }, (e) => events.push(e), new AbortController().signal);
    const commandEvent = events.find((e) => e.type === 'command-completed');
    expect(commandEvent).toMatchObject({ exitCode: 1 });
  });

  it('simulates QA failures via findings on the qa-executor role', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'qa-executor', {
      findings: [
        {
          id: 'f2',
          taskId: 'task-1',
          severity: 'high',
          category: 'correctness',
          claimIds: [],
          description: 'button click does not navigate',
          status: 'open',
        },
      ],
    });
    const session = await makeSession(adapter, 'task-1', 'qa-executor');
    const result = await adapter.execute(session, { instruction: 'exercise the login flow' }, () => {}, new AbortController().signal);
    expect(result.findings[0]?.category).toBe('correctness');
  });

  it('simulates review findings on the adversarial-reviewer role', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'adversarial-reviewer', {
      findings: [
        {
          id: 'f3',
          taskId: 'task-1',
          severity: 'medium',
          category: 'security',
          claimIds: [],
          description: 'missing auth check',
          status: 'open',
        },
      ],
    });
    const session = await makeSession(adapter, 'task-1', 'adversarial-reviewer');
    const result = await adapter.execute(session, { instruction: 'review the diff' }, () => {}, new AbortController().signal);
    expect(result.findings[0]?.category).toBe('security');
  });

  it('reports token usage', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', {
      usage: { provider: 'mock', model: 'mock-model', inputTokens: 1000, outputTokens: 200 },
    });
    const session = await makeSession(adapter, 'task-1', 'builder');
    const events: AgentEvent[] = [];
    const result = await adapter.execute(session, { instruction: 'implement' }, (e) => events.push(e), new AbortController().signal);
    expect(result.usage?.inputTokens).toBe(1000);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('simulates a timeout via an aborted signal', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', { delayMs: 50 });
    const session = await makeSession(adapter, 'task-1', 'builder');
    const controller = new AbortController();
    const promise = adapter.execute(session, { instruction: 'slow task' }, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const result = await promise;
    expect(result.completed).toBe(false);
  });

  it('simulates a provider crash via throws', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', { throws: new Error('provider crashed') });
    const session = await makeSession(adapter, 'task-1', 'builder');
    await expect(adapter.execute(session, { instruction: 'implement' }, () => {}, new AbortController().signal)).rejects.toThrow(
      'provider crashed',
    );
  });

  it('simulates repeated identical failure signatures across turns', async () => {
    const adapter = new MockAgentAdapter();
    const repeatedFinding = {
      id: 'f-repeat',
      taskId: 'task-1',
      severity: 'high' as const,
      category: 'correctness' as const,
      claimIds: [],
      description: 'same assertion keeps failing',
      status: 'open' as const,
    };
    adapter.scriptTurns('task-1', 'verifier', { findings: [repeatedFinding] }, { findings: [repeatedFinding] });
    const session = await makeSession(adapter, 'task-1', 'verifier');
    const first = await adapter.execute(session, { instruction: 'verify' }, () => {}, new AbortController().signal);
    const second = await adapter.execute(session, { instruction: 'verify' }, () => {}, new AbortController().signal);
    expect(first.findings[0]?.description).toBe(second.findings[0]?.description);
  });

  it('repeats the last scripted turn once the queue is exhausted', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', { summary: 'turn one' });
    const session = await makeSession(adapter, 'task-1', 'builder');
    const first = await adapter.execute(session, { instruction: 'go' }, () => {}, new AbortController().signal);
    const second = await adapter.execute(session, { instruction: 'go' }, () => {}, new AbortController().signal);
    expect(first.summary).toBe('turn one');
    expect(second.summary).toBe('turn one');
  });

  it('interrupt() causes a subsequent execute() to report not completed', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'builder', { delayMs: 20 });
    const session = await makeSession(adapter, 'task-1', 'builder');
    await adapter.interrupt(session);
    const result = await adapter.execute(session, { instruction: 'go' }, () => {}, new AbortController().signal);
    expect(result.completed).toBe(false);
  });

  it('dispose() removes the session', async () => {
    const adapter = new MockAgentAdapter();
    const session = await makeSession(adapter, 'task-1', 'builder');
    await expect(adapter.dispose(session)).resolves.toBeUndefined();
  });

  it('scripts different roles independently for the same task', async () => {
    const adapter = new MockAgentAdapter();
    adapter.scriptTurns('task-1', 'planner', { summary: 'planner turn' });
    adapter.scriptTurns('task-1', 'builder', { summary: 'builder turn' });
    const plannerSession = await makeSession(adapter, 'task-1', 'planner');
    const builderSession = await makeSession(adapter, 'task-1', 'builder');
    const plannerResult = await adapter.execute(plannerSession, { instruction: 'plan' }, () => {}, new AbortController().signal);
    const builderResult = await adapter.execute(builderSession, { instruction: 'build' }, () => {}, new AbortController().signal);
    expect(plannerResult.summary).toBe('planner turn');
    expect(builderResult.summary).toBe('builder turn');
  });
});
