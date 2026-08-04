import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from './mock-adapter.js';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { PiAgentAdapter } from './pi-adapter.js';
import { OpenCodeAgentAdapter } from './opencode-adapter.js';
import { AGENT_RUNTIMES, isAgentRuntime, runtimeProfile } from './runtime-profile.js';

describe('runtime-profile registry', () => {
  it('has a profile for every declared runtime', () => {
    for (const runtime of AGENT_RUNTIMES) {
      expect(runtimeProfile(runtime).runtime).toBe(runtime);
    }
  });

  it('isAgentRuntime accepts the declared runtimes and rejects others', () => {
    expect(isAgentRuntime('claude')).toBe(true);
    expect(isAgentRuntime('opencode')).toBe(true);
    expect(isAgentRuntime('gpt')).toBe(false);
    expect(isAgentRuntime('')).toBe(false);
  });

  it('only mock is not a real agent', () => {
    expect(runtimeProfile('mock').usesRealAgent).toBe(false);
    for (const runtime of ['claude', 'codex', 'pi', 'opencode'] as const) {
      expect(runtimeProfile(runtime).usesRealAgent).toBe(true);
    }
  });

  it('mock uses neither a real worktree nor durable run state; real runtimes use both', () => {
    expect(runtimeProfile('mock').usesRealWorktree).toBe(false);
    expect(runtimeProfile('mock').usesDurableRunState).toBe(false);
    for (const runtime of ['claude', 'codex', 'pi', 'opencode'] as const) {
      expect(runtimeProfile(runtime).usesRealWorktree).toBe(true);
      expect(runtimeProfile(runtime).usesDurableRunState).toBe(true);
    }
  });

  it('only claude speaks SDK tool names', () => {
    expect(runtimeProfile('claude').usesSdkToolNames).toBe(true);
    for (const runtime of ['mock', 'codex', 'pi', 'opencode'] as const) {
      expect(runtimeProfile(runtime).usesSdkToolNames).toBe(false);
    }
  });

  it('createAdapter yields the matching adapter, threading model/binary config to CLI adapters', () => {
    expect(runtimeProfile('mock').createAdapter({})).toBeInstanceOf(MockAgentAdapter);
    expect(runtimeProfile('claude').createAdapter({})).toBeInstanceOf(ClaudeAgentAdapter);
    expect(runtimeProfile('codex').createAdapter({ model: 'gpt-5.2-codex' })).toBeInstanceOf(CodexAgentAdapter);
    expect(runtimeProfile('pi').createAdapter({ model: 'ollama/qwen3-coder:30b', binary: 'pi' })).toBeInstanceOf(PiAgentAdapter);
    expect(runtimeProfile('opencode').createAdapter({ model: 'anthropic/claude-sonnet-4-5' })).toBeInstanceOf(OpenCodeAgentAdapter);
  });
});
