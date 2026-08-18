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

// The no-progress tracker (NoProgressState/initialNoProgressState/recordAttempt/isNoProgress) is
// crypto-free and lives in `no-progress.ts` so it can be imported into the Temporal Workflow
// sandbox (this module's `node:crypto` use runs only inside Activities). Re-exported here so
// existing `@awb/workflow` consumers keep their import site.
export {
  type NoProgressState,
  initialNoProgressState,
  recordAttempt,
  isNoProgress,
} from './no-progress.js';
