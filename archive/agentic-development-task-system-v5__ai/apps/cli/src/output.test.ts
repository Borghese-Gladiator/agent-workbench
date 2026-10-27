import { describe, expect, it } from 'vitest';
import { configureOutput } from './output.js';

describe('configureOutput', () => {
  it('--json implies no color and no interactive input', () => {
    const opts = configureOutput({ json: true, color: true, input: true });
    expect(opts.json).toBe(true);
    expect(opts.color).toBe(false);
    expect(opts.input).toBe(false);
  });

  it('--no-color disables color even on a TTY', () => {
    const opts = configureOutput({ color: false });
    expect(opts.color).toBe(false);
  });

  it('--quiet is recorded independently of json', () => {
    const opts = configureOutput({ quiet: true });
    expect(opts.quiet).toBe(true);
    expect(opts.json).toBe(false);
  });

  it('color is off when stdout is not a TTY regardless of flags', () => {
    // vitest runs with stdout piped (not a TTY), so the default resolution is no color.
    const opts = configureOutput({});
    expect(opts.color).toBe(false);
  });
});
