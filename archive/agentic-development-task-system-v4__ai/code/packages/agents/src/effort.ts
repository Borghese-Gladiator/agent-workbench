/**
 * Neutral "how hard should the model think" level. The VALUES happen to match
 * Claude's `--effort` flag tokens (passed straight through by that adapter); the
 * Pi adapter maps them onto its `--thinking` levels. Per-stage assignment lives
 * in each {@link RuntimeProfile} (runtime-profile.ts), not here — model/effort
 * routing is runtime-specific.
 *
 * This is a LEAF module (no imports) so both the barrel (`index.ts`) and
 * `runtime-profile.ts` can read `Effort` without a circular-init hazard.
 */
export enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh',
  Max = 'max',
}
