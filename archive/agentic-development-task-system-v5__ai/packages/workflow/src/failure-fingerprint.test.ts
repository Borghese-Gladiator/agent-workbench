import { describe, expect, it } from 'vitest';
import {
  computeFailureFingerprint,
  sameFailureFingerprint,
  initialNoProgressState,
  recordAttempt,
  isNoProgress,
  type FailureFingerprintInput,
} from './failure-fingerprint.js';

const base: FailureFingerprintInput = {
  command: 'pnpm test',
  exitCode: 1,
  failingTestIds: ['test/a.test.ts > works', 'test/b.test.ts > also works'],
  normalizedErrorClass: 'AssertionError',
  topRelevantStackFrame: 'src/foo.ts:42',
};

describe('computeFailureFingerprint', () => {
  it('is identical for identical inputs', () => {
    expect(computeFailureFingerprint(base)).toBe(computeFailureFingerprint({ ...base }));
  });

  it('is identical regardless of failingTestIds order', () => {
    const reordered: FailureFingerprintInput = {
      ...base,
      failingTestIds: [...base.failingTestIds].reverse(),
    };
    expect(sameFailureFingerprint(base, reordered)).toBe(true);
  });

  it('differs when the command differs', () => {
    expect(sameFailureFingerprint(base, { ...base, command: 'pnpm lint' })).toBe(false);
  });

  it('differs when the exit code differs', () => {
    expect(sameFailureFingerprint(base, { ...base, exitCode: 2 })).toBe(false);
  });

  it('differs when the failing test set differs', () => {
    expect(sameFailureFingerprint(base, { ...base, failingTestIds: ['test/c.test.ts > other'] })).toBe(false);
  });

  it('differs when the normalized error class differs', () => {
    expect(sameFailureFingerprint(base, { ...base, normalizedErrorClass: 'TypeError' })).toBe(false);
  });

  it('differs when the top stack frame differs', () => {
    expect(sameFailureFingerprint(base, { ...base, topRelevantStackFrame: 'src/bar.ts:1' })).toBe(false);
  });
});

describe('no-progress detection', () => {
  it('detects no progress after repeated identical fingerprints', () => {
    let state = initialNoProgressState();
    const fp = computeFailureFingerprint(base);
    state = recordAttempt(state, fp);
    state = recordAttempt(state, fp);
    state = recordAttempt(state, fp);
    expect(isNoProgress(state, 3)).toBe(true);
  });

  it('resets the streak when the fingerprint changes', () => {
    let state = initialNoProgressState();
    state = recordAttempt(state, computeFailureFingerprint(base));
    state = recordAttempt(state, computeFailureFingerprint(base));
    state = recordAttempt(state, computeFailureFingerprint({ ...base, exitCode: 2 }));
    expect(isNoProgress(state, 3)).toBe(false);
    expect(state.consecutiveIdenticalFingerprints).toBe(1);
  });

  it('does not report no-progress below the threshold', () => {
    let state = initialNoProgressState();
    state = recordAttempt(state, computeFailureFingerprint(base));
    expect(isNoProgress(state, 3)).toBe(false);
  });
});
