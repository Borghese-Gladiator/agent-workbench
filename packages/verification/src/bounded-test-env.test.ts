import { describe, it, expect, afterEach } from 'vitest';
import { cpus } from 'node:os';
import { boundedTestEnv } from './verification-runner.js';

const ORIG_CAP = process.env.AWB_TEST_MAX_WORKERS;
const ORIG_ACTIVITIES = process.env.AWB_MAX_CONCURRENT_ACTIVITIES;
afterEach(() => {
  restore('AWB_TEST_MAX_WORKERS', ORIG_CAP);
  restore('AWB_MAX_CONCURRENT_ACTIVITIES', ORIG_ACTIVITIES);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The cap boundedTestEnv derives when AWB_TEST_MAX_WORKERS is unset — kept machine-independent. */
function derivedCap(activities: number): number {
  return Math.max(1, Math.floor(cpus().length / activities));
}

describe('boundedTestEnv', () => {
  it('bounds a unit-test command when AWB_TEST_MAX_WORKERS is set', () => {
    process.env.AWB_TEST_MAX_WORKERS = '2';
    const env = boundedTestEnv('unit-test', { PATH: '/usr/bin' });
    expect(env.VITEST_MAX_THREADS).toBe('2');
    expect(env.VITEST_MIN_THREADS).toBe('2');
    // the forks pool is configured by a separate pair — a suite on `pool: 'forks'` reads only these
    expect(env.VITEST_MAX_FORKS).toBe('2');
    expect(env.VITEST_MIN_FORKS).toBe('2');
    expect(env.PATH).toBe('/usr/bin'); // original env preserved
  });

  it('bounds integration-test too', () => {
    process.env.AWB_TEST_MAX_WORKERS = '3';
    const env = boundedTestEnv('integration-test', {});
    expect(env.VITEST_MAX_THREADS).toBe('3');
    expect(env.VITEST_MAX_FORKS).toBe('3');
  });

  it('leaves non-test purposes untouched', () => {
    process.env.AWB_TEST_MAX_WORKERS = '2';
    const input = { PATH: '/usr/bin' };
    expect(boundedTestEnv('build', input)).toBe(input);
    expect(boundedTestEnv('lint', input)).toBe(input);
    expect(boundedTestEnv('typecheck', input)).toBe(input);
  });

  it('bounds by a derived default when the cap env is unset', () => {
    // TASK-112's per-verify lever must hold without an operator setting anything, so an unset cap
    // derives from the core count and the activity cap rather than leaving the pool unbounded.
    delete process.env.AWB_TEST_MAX_WORKERS;
    delete process.env.AWB_MAX_CONCURRENT_ACTIVITIES;
    const env = boundedTestEnv('unit-test', { PATH: '/usr/bin' });
    expect(env.VITEST_MAX_THREADS).toBe(String(derivedCap(4)));
    expect(env.VITEST_MAX_FORKS).toBe(String(derivedCap(4)));
    expect(env.PATH).toBe('/usr/bin');
  });

  it('falls back to the derived default for a non-positive-integer cap', () => {
    process.env.AWB_TEST_MAX_WORKERS = 'lots';
    delete process.env.AWB_MAX_CONCURRENT_ACTIVITIES;
    const env = boundedTestEnv('unit-test', {});
    expect(env.VITEST_MAX_THREADS).toBe(String(derivedCap(4)));
  });

  it('divides the derived cap by the activity cap so the two levers compose', () => {
    delete process.env.AWB_TEST_MAX_WORKERS;
    process.env.AWB_MAX_CONCURRENT_ACTIVITIES = '2';
    const env = boundedTestEnv('unit-test', {});
    expect(env.VITEST_MAX_THREADS).toBe(String(derivedCap(2)));
  });

  it('floors the derived cap at 1 when activities outnumber cores', () => {
    delete process.env.AWB_TEST_MAX_WORKERS;
    process.env.AWB_MAX_CONCURRENT_ACTIVITIES = String(cpus().length * 4);
    const env = boundedTestEnv('unit-test', {});
    expect(env.VITEST_MAX_THREADS).toBe('1');
  });

  it('lets an explicit cap win over the derived default', () => {
    process.env.AWB_TEST_MAX_WORKERS = '7';
    process.env.AWB_MAX_CONCURRENT_ACTIVITIES = '2';
    const env = boundedTestEnv('unit-test', {});
    expect(env.VITEST_MAX_THREADS).toBe('7');
    expect(env.VITEST_MAX_FORKS).toBe('7');
  });

  it('does not override a caller-supplied worker env', () => {
    process.env.AWB_TEST_MAX_WORKERS = '2';
    const env = boundedTestEnv('unit-test', { VITEST_MAX_THREADS: '8', VITEST_MAX_FORKS: '9' });
    expect(env.VITEST_MAX_THREADS).toBe('8');
    expect(env.VITEST_MAX_FORKS).toBe('9');
  });
});
