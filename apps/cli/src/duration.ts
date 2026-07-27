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
