export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Compact token count: 850 → "850", 12108 → "12.1k", 3400000 → "3.4M". Exact value belongs on hover. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Human-readable duration from milliseconds: 225909 → "3m 46s", 5400000 → "1h 30m", 800 → "0.8s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Elapsed wall-clock between two ISO timestamps (or now), formatted; empty when start is missing. */
export function elapsedBetween(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  return formatDuration(end - start);
}

/**
 * A concise task title derived from the prompt as a fallback when no explicit title is stored:
 * the first sentence (or first ~72 chars), trimmed.
 */
export function deriveTaskTitle(prompt: string): string {
  const firstSentence = prompt.trim().split(/(?<=[.!?])\s/)[0] ?? prompt.trim();
  const clipped = firstSentence.length > 72 ? `${firstSentence.slice(0, 69).trimEnd()}…` : firstSentence;
  return clipped || 'Untitled task';
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.round((now - then) / 1000);
  if (deltaSec < 5) return 'just now';
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = deltaSec;
  let unit = 'second';
  for (const [size, name] of units) {
    if (value < size) {
      unit = name;
      break;
    }
    value = Math.floor(value / size);
    unit = name;
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
