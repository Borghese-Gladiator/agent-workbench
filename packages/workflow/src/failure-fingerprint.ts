import { createHash } from 'node:crypto';

/**
 * A failure fingerprint (product spec §21) identifies "the same failure happening again" so the
 * builder loop's no-progress detector can distinguish real progress from an edit/revert loop.
 */
export interface FailureFingerprintInput {
  command: string;
  exitCode: number;
  failingTestIds: string[];
  normalizedErrorClass: string;
  topRelevantStackFrame: string;
}

function normalize(input: FailureFingerprintInput): string {
  const sortedTestIds = [...input.failingTestIds].sort();
  return [
    `command=${input.command}`,
    `exitCode=${input.exitCode}`,
    `failingTests=${sortedTestIds.join(',')}`,
    `errorClass=${input.normalizedErrorClass}`,
    `topFrame=${input.topRelevantStackFrame}`,
  ].join('|');
}

/** Deterministic fingerprint: identical inputs always hash identically; any differing field changes the hash. */
export function computeFailureFingerprint(input: FailureFingerprintInput): string {
  return createHash('sha256').update(normalize(input)).digest('hex');
}

export function sameFailureFingerprint(a: FailureFingerprintInput, b: FailureFingerprintInput): boolean {
  return computeFailureFingerprint(a) === computeFailureFingerprint(b);
}

/**
 * No-progress detection (product spec §21): tracks consecutive identical fingerprints and other
 * no-progress signals across builder attempts.
 */
export interface NoProgressState {
  consecutiveIdenticalFingerprints: number;
  lastFingerprint?: string;
}

export function initialNoProgressState(): NoProgressState {
  return { consecutiveIdenticalFingerprints: 0 };
}

export function recordAttempt(state: NoProgressState, fingerprint: string): NoProgressState {
  if (state.lastFingerprint === fingerprint) {
    return {
      lastFingerprint: fingerprint,
      consecutiveIdenticalFingerprints: state.consecutiveIdenticalFingerprints + 1,
    };
  }
  return { lastFingerprint: fingerprint, consecutiveIdenticalFingerprints: 1 };
}

export function isNoProgress(state: NoProgressState, threshold: number): boolean {
  return state.consecutiveIdenticalFingerprints >= threshold;
}
