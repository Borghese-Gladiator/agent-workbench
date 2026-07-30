import { describe, it, expect } from 'vitest';
import { shortId, relativeTime } from './format.js';

describe('shortId', () => {
  it('returns the first 8 characters', () => {
    expect(shortId('ed33645f-1111-2222-3333-444455556666')).toBe('ed33645f');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-07-30T12:00:00Z').getTime();

  it.each([
    ['2026-07-30T11:59:58Z', 'just now'],
    ['2026-07-30T11:57:00Z', '3 minutes ago'],
    ['2026-07-30T11:59:00Z', '1 minute ago'],
    ['2026-07-30T09:00:00Z', '3 hours ago'],
    ['2026-07-28T12:00:00Z', '2 days ago'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('returns the raw string for an invalid date', () => {
    expect(relativeTime('not-a-date', now)).toBe('not-a-date');
  });
});
