/**
 * Parses a compact duration like `10m`, `1500ms`, `2h`, `30s`, or a bare number (seconds) into
 * milliseconds. Throws on anything unrecognized so callers surface a clear error.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${input}". Use forms like 30s, 10m, 2h, 500ms.`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1_000;
  return value * factor;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** What every duration cell in the CLI prints when the span is unknown. */
const UNKNOWN = '—';

/**
 * Coarse duration — one whole unit: `45s`, `2m`, `2h`, `2d`. Use where the reader only needs an
 * order of magnitude (a task's age, a service's uptime).
 */
export function formatDurationCoarse(ms: number | null | undefined): string {
  if (ms == null) return UNKNOWN;
  if (ms < MINUTE_MS) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/**
 * Precise duration — keeps sub-second and minute+second detail: `3ms`, `1.5s`, `3m25s`. Phase
 * attempts span five orders of magnitude in a single run (3ms to 3m25s observed), so the coarse
 * form renders the short ones as `0s` and hides exactly what a timeline is read for.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return UNKNOWN;
  if (ms < 1000) return `${ms}ms`;
  if (ms < MINUTE_MS) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / MINUTE_MS);
  const seconds = Math.round((ms % MINUTE_MS) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
