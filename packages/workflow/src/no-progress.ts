/**
 * No-progress detection (product spec §21): tracks consecutive identical failure fingerprints and
 * other no-progress signals across builder attempts. Deliberately dependency-free (no `node:crypto`)
 * so it is safe to import into the Temporal Workflow sandbox — the fingerprint *hashing* that needs
 * crypto lives in `failure-fingerprint.ts`, which runs only inside Activities.
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
