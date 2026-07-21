import { describe, expect, it } from 'vitest';
import { resolveCandidateSha, resolveBaseSha } from './run-phase.js';

describe('SHA resolution (Fix 1: thread the real SHA)', () => {
  it('falls back to the fake constants when no real SHA is present (mock path)', () => {
    expect(resolveCandidateSha({})).toBe('f'.repeat(40));
    expect(resolveBaseSha({})).toBe('0'.repeat(40));
  });

  it('returns the real SHA when the builder/worktree produced one (claude path)', () => {
    const real = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(resolveCandidateSha({ candidateSha: real })).toBe(real);
    expect(resolveBaseSha({ baseSha: real })).toBe(real);
  });

  it('never returns the fake constant once a real SHA is set', () => {
    const real = '0000000000000000000000000000000000000abc';
    expect(resolveCandidateSha({ candidateSha: real })).not.toBe('f'.repeat(40));
  });
});
