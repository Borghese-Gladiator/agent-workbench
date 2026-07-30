import { exactTime, relativeTime } from '../lib/format.js';

/** Relative timestamp label with the exact time available on hover/focus via the title attribute. */
export function RelativeTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={exactTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}
