import { afterEach, describe, expect, it } from 'vitest';
import {
  MockAgentAdapter,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  PiAgentAdapter,
  OpenCodeAgentAdapter,
} from '@awb/agent-gateway';
import { createAgentAdapter, resolveAgentRuntime, resolveRuntimeProfile, scriptMockTurns } from './agent-factory.js';

describe('agent factory', () => {
  afterEach(() => {
    delete process.env.AWB_AGENT_RUNTIME;
  });

  it('defaults to the mock adapter when AWB_AGENT_RUNTIME is unset', () => {
    delete process.env.AWB_AGENT_RUNTIME;
    expect(resolveAgentRuntime()).toBe('mock');
    expect(createAgentAdapter()).toBeInstanceOf(MockAgentAdapter);
  });

  it('returns the mock adapter for an unrecognized value (typo degrades to offline)', () => {
    process.env.AWB_AGENT_RUNTIME = 'something-else';
    expect(resolveAgentRuntime()).toBe('mock');
    expect(createAgentAdapter()).toBeInstanceOf(MockAgentAdapter);
  });

  it.each([
    ['claude', ClaudeAgentAdapter],
    ['codex', CodexAgentAdapter],
    ['pi', PiAgentAdapter],
    ['opencode', OpenCodeAgentAdapter],
  ] as const)('maps AWB_AGENT_RUNTIME=%s to the right real adapter', (runtime, Adapter) => {
    process.env.AWB_AGENT_RUNTIME = runtime;
    expect(resolveAgentRuntime()).toBe(runtime);
    expect(createAgentAdapter()).toBeInstanceOf(Adapter);
  });

  it('only the mock profile is not a real agent; every other runtime is real-worktree + durable', () => {
    expect(resolveRuntimeProfile('mock').usesRealAgent).toBe(false);
    for (const runtime of ['claude', 'codex', 'pi', 'opencode'] as const) {
      const profile = resolveRuntimeProfile(runtime);
      expect(profile.usesRealAgent).toBe(true);
      expect(profile.usesRealWorktree).toBe(true);
      expect(profile.usesDurableRunState).toBe(true);
    }
  });

  it('only the claude profile speaks SDK tool names (CLI adapters take capability strings)', () => {
    expect(resolveRuntimeProfile('claude').usesSdkToolNames).toBe(true);
    for (const runtime of ['mock', 'codex', 'pi', 'opencode'] as const) {
      expect(resolveRuntimeProfile(runtime).usesSdkToolNames).toBe(false);
    }
  });

  it('scriptMockTurns scripts on a mock and is a no-op on a real adapter', () => {
    const mock = new MockAgentAdapter();
    expect(() => scriptMockTurns(mock, 'task-1', 'planner', { summary: 'x' })).not.toThrow();
    const real = new CodexAgentAdapter();
    expect(() => scriptMockTurns(real, 'task-1', 'planner', { summary: 'x' })).not.toThrow();
  });
});
