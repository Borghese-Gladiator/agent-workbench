import { describe, expect, it } from 'vitest';
import type { TaskPhase } from '@awb/domain';
import { defaultModelForPhase, defaultPhaseModelRouting } from './phase-model-routing.js';

describe('phase-model routing table', () => {
  it('classifies heavy reasoning phases as heavy and the rest as light', () => {
    const routing = defaultPhaseModelRouting('claude')!;
    for (const phase of ['plan', 'program-design', 'implement', 'challenge'] as TaskPhase[]) {
      expect(routing.tierForPhase(phase)).toBe('heavy');
    }
    for (const phase of ['specify', 'prepare', 'verify', 'exercise', 'release', 'assimilate'] as TaskPhase[]) {
      expect(routing.tierForPhase(phase)).toBe('light');
    }
  });

  it('has a routing table for the frontier CLI runtimes but not mock/pi', () => {
    for (const runtime of ['claude', 'codex', 'opencode'] as const) {
      const routing = defaultPhaseModelRouting(runtime)!;
      expect(routing.modelForTier.light).toBeTruthy();
      expect(routing.modelForTier.heavy).toBeTruthy();
      expect(routing.modelForTier.heavy).not.toBe(routing.modelForTier.light);
    }
    expect(defaultPhaseModelRouting('mock')).toBeUndefined();
    expect(defaultPhaseModelRouting('pi')).toBeUndefined();
  });
});

describe('defaultModelForPhase', () => {
  it('drives >=2 runtimes: heavy phase → heavy model, light phase → light model', () => {
    for (const runtime of ['claude', 'codex', 'opencode'] as const) {
      const routing = defaultPhaseModelRouting(runtime)!;
      expect(defaultModelForPhase(runtime, 'implement', {})).toBe(routing.modelForTier.heavy);
      expect(defaultModelForPhase(runtime, 'verify', {})).toBe(routing.modelForTier.light);
    }
  });

  it('a configured model overrides the table for every phase', () => {
    expect(defaultModelForPhase('claude', 'implement', { model: 'pinned' })).toBe('pinned');
    expect(defaultModelForPhase('codex', 'verify', { model: 'pinned' })).toBe('pinned');
  });

  it('returns undefined (adapter default) for a runtime with no routing table', () => {
    expect(defaultModelForPhase('mock', 'implement', {})).toBeUndefined();
    expect(defaultModelForPhase('pi', 'implement', {})).toBeUndefined();
  });
});
