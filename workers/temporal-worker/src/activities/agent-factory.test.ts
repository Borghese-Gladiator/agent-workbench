import { afterEach, describe, expect, it } from 'vitest';
import { MockAgentAdapter, ClaudeAgentAdapter } from '@awb/agent-gateway';
import { createAgentAdapter, resolveAgentRuntime, scriptMockTurns } from './agent-factory.js';

describe('agent factory', () => {
  afterEach(() => {
    delete process.env.AWB_AGENT_RUNTIME;
  });

  it('defaults to the mock adapter when AWB_AGENT_RUNTIME is unset', () => {
    delete process.env.AWB_AGENT_RUNTIME;
    expect(resolveAgentRuntime()).toBe('mock');
    expect(createAgentAdapter()).toBeInstanceOf(MockAgentAdapter);
  });

  it('returns the mock adapter for any non-claude value', () => {
    process.env.AWB_AGENT_RUNTIME = 'something-else';
    expect(resolveAgentRuntime()).toBe('mock');
    expect(createAgentAdapter()).toBeInstanceOf(MockAgentAdapter);
  });

  it('returns the Claude adapter when AWB_AGENT_RUNTIME=claude', () => {
    process.env.AWB_AGENT_RUNTIME = 'claude';
    expect(resolveAgentRuntime()).toBe('claude');
    expect(createAgentAdapter()).toBeInstanceOf(ClaudeAgentAdapter);
  });

  it('scriptMockTurns scripts on a mock and is a no-op on the real adapter', () => {
    const mock = new MockAgentAdapter();
    expect(() => scriptMockTurns(mock, 'task-1', 'planner', { summary: 'x' })).not.toThrow();
    // On the real adapter this must not throw (and must not call a non-existent scriptTurns).
    const real = new ClaudeAgentAdapter();
    expect(() => scriptMockTurns(real, 'task-1', 'planner', { summary: 'x' })).not.toThrow();
  });
});
