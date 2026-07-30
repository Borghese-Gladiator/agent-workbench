/** First 8 chars of a UUID, e.g. `ed33645f`, for compact display. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Relative time label such as `3 minutes ago` / `just now`. */
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
  const plural = value === 1 ? '' : 's';
  return `${value} ${unit}${plural} ago`;
}

/** Exact, human-readable timestamp for tooltips. */
export function exactTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
