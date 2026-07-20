import { describe, expect, it } from 'vitest';
import { computeEnvironmentDigest } from './environment-digest.js';

describe('computeEnvironmentDigest', () => {
  const baseInput = {
    platform: 'darwin',
    nodeVersion: 'v20.11.0',
    toolVersions: { pnpm: '9.0.0', python: '3.11.4' },
    env: { NODE_ENV: 'test', PATH: '/usr/bin' },
  };

  it('produces the same digest for identical inputs', () => {
    expect(computeEnvironmentDigest(baseInput)).toBe(computeEnvironmentDigest({ ...baseInput }));
  });

  it('produces the same digest regardless of record key order', () => {
    const reordered = {
      ...baseInput,
      toolVersions: { python: '3.11.4', pnpm: '9.0.0' },
      env: { PATH: '/usr/bin', NODE_ENV: 'test' },
    };
    expect(computeEnvironmentDigest(baseInput)).toBe(computeEnvironmentDigest(reordered));
  });

  it('changes when platform changes', () => {
    expect(computeEnvironmentDigest(baseInput)).not.toBe(
      computeEnvironmentDigest({ ...baseInput, platform: 'linux' }),
    );
  });

  it('changes when node version changes', () => {
    expect(computeEnvironmentDigest(baseInput)).not.toBe(
      computeEnvironmentDigest({ ...baseInput, nodeVersion: 'v22.0.0' }),
    );
  });

  it('changes when a tool version changes', () => {
    const changed = { ...baseInput, toolVersions: { ...baseInput.toolVersions, pnpm: '9.1.0' } };
    expect(computeEnvironmentDigest(baseInput)).not.toBe(computeEnvironmentDigest(changed));
  });

  it('changes when a resolved env var value changes', () => {
    const changed = { ...baseInput, env: { ...baseInput.env, NODE_ENV: 'production' } };
    expect(computeEnvironmentDigest(baseInput)).not.toBe(computeEnvironmentDigest(changed));
  });

  it('defaults missing toolVersions/env to empty and stays deterministic', () => {
    const minimal = { platform: 'darwin', nodeVersion: 'v20.11.0' };
    expect(computeEnvironmentDigest(minimal)).toBe(computeEnvironmentDigest({ ...minimal }));
    expect(computeEnvironmentDigest(minimal)).not.toBe(computeEnvironmentDigest(baseInput));
  });
});
