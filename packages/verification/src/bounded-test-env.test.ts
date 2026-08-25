import { describe, it, expect, afterEach } from 'vitest';
import { boundedTestEnv } from './verification-runner.js';

const ORIG = process.env.AWB_TEST_MAX_WORKERS;
afterEach(() => {
  if (ORIG === undefined) delete process.env.AWB_TEST_MAX_WORKERS;
  else process.env.AWB_TEST_MAX_WORKERS = ORIG;
});

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

  it('is a no-op when the cap env is unset', () => {
    delete process.env.AWB_TEST_MAX_WORKERS;
    const input = { PATH: '/usr/bin' };
    expect(boundedTestEnv('unit-test', input)).toBe(input);
  });

  it('ignores a non-positive-integer cap', () => {
    process.env.AWB_TEST_MAX_WORKERS = 'lots';
    const input = { PATH: '/usr/bin' };
    expect(boundedTestEnv('unit-test', input)).toBe(input);
  });

  it('does not override a caller-supplied worker env', () => {
    process.env.AWB_TEST_MAX_WORKERS = '2';
    const env = boundedTestEnv('unit-test', { VITEST_MAX_THREADS: '8', VITEST_MAX_FORKS: '9' });
    expect(env.VITEST_MAX_THREADS).toBe('8');
    expect(env.VITEST_MAX_FORKS).toBe('9');
  });
});
