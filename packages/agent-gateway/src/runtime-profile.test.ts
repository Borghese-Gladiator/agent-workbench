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

  it('only local-model runtimes (pi, opencode) need stringent candidate checks', () => {
    for (const runtime of ['pi', 'opencode'] as const) {
      expect(runtimeProfile(runtime).needsStringentCandidateChecks).toBe(true);
    }
    for (const runtime of ['mock', 'claude', 'codex'] as const) {
      expect(runtimeProfile(runtime).needsStringentCandidateChecks).toBe(false);
    }
  });

  it('local-model runtimes get the recipes tool-doc tier; frontier ones get full', () => {
    expect(runtimeProfile('pi').toolDocTier).toBe('recipes');
    expect(runtimeProfile('mock').toolDocTier).toBe('recipes');
    for (const runtime of ['claude', 'codex', 'opencode'] as const) {
      expect(runtimeProfile(runtime).toolDocTier).toBe('full');
    }
  });

  it('pi routes the heavy challenge phase to a fast model and keeps the capable default elsewhere', () => {
    const pi = runtimeProfile('pi');
    expect(pi.modelForPhase('challenge', {})).toBe('ollama/llama3.2:latest');
    expect(pi.modelForPhase('implement', {})).toBe('ollama/qwen3-coder:30b');
    expect(pi.modelForPhase('plan', {})).toBe('ollama/qwen3-coder:30b');
    // A project-configured model overrides the per-phase table for every phase.
    expect(pi.modelForPhase('challenge', { model: 'ollama/custom' })).toBe('ollama/custom');
  });

  it('one-model runtimes return the configured model (or undefined) for every phase', () => {
    for (const runtime of ['claude', 'codex', 'opencode'] as const) {
      expect(runtimeProfile(runtime).modelForPhase('challenge', {})).toBeUndefined();
      expect(runtimeProfile(runtime).modelForPhase('implement', { model: 'm' })).toBe('m');
    }
  });
});
