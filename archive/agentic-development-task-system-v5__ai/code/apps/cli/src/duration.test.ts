import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationCoarse, parseDuration } from './duration.js';

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['10m', 600_000],
    ['2h', 7_200_000],
    ['500ms', 500],
    ['45', 45_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('throws on an unrecognized form', () => {
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
  });
});

describe('formatDuration (precise)', () => {
  it.each([
    [null, '—'],
    [undefined, '—'],
    [0, '0ms'],
    [3, '3ms'],
    [999, '999ms'],
    [1500, '1.5s'],
    [59_999, '60.0s'],
    [60_000, '1m00s'],
    [125_000, '2m05s'],
    [204_754, '3m25s'],
  ])('renders %s as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('keeps sub-second spans distinguishable, which the coarse form cannot', () => {
    // A real run had phase attempts of 3ms, 14ms and 21ms alongside one of 3m25s.
    expect(new Set([formatDuration(3), formatDuration(14), formatDuration(21)]).size).toBe(3);
    expect(new Set([formatDurationCoarse(3), formatDurationCoarse(14)]).size).toBe(1);
  });
});

describe('formatDurationCoarse', () => {
  it.each([
    [null, '—'],
    [undefined, '—'],
    [45_000, '45s'],
    [125_000, '2m'],
    [7_200_000, '2h'],
    [172_800_000, '2d'],
  ])('renders %s as %s', (ms, expected) => {
    expect(formatDurationCoarse(ms)).toBe(expected);
  });
});
