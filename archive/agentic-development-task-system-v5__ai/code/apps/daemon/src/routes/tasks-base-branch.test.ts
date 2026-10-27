import { describe, it, expect, vi } from 'vitest';
import { resolveRecoveryBaseBranch } from './tasks.js';

describe('resolveRecoveryBaseBranch', () => {
  it('uses the lease baseRef and never consults the repo default', async () => {
    const repoDefault = vi.fn(async () => 'main');
    await expect(resolveRecoveryBaseBranch({ baseRef: 'awb/parent-slug' }, repoDefault)).resolves.toBe(
      'awb/parent-slug',
    );
    expect(repoDefault).not.toHaveBeenCalled();
  });

  it('keeps a stacked child on its parent branch rather than the repo default', async () => {
    // The TASK-114 regression: the original inline form gated this on a condition that was always
    // true, so every recovered PR opened against the repo default and broke the stack.
    await expect(
      resolveRecoveryBaseBranch({ baseRef: 'awb/parent-slug' }, async () => 'main'),
    ).resolves.not.toBe('main');
  });

  it('falls back to the repo default branch when the lease has no baseRef', async () => {
    await expect(resolveRecoveryBaseBranch({}, async () => 'master')).resolves.toBe('master');
  });

  it('falls back to the repo default branch when there is no lease at all', async () => {
    await expect(resolveRecoveryBaseBranch(undefined, async () => 'master')).resolves.toBe('master');
  });

  it("falls back to 'main' when the repo default cannot be read", async () => {
    await expect(
      resolveRecoveryBaseBranch({}, async () => {
        throw new Error('not a git repository');
      }),
    ).resolves.toBe('main');
  });

  it('treats an empty baseRef as absent', async () => {
    await expect(resolveRecoveryBaseBranch({ baseRef: '' }, async () => 'master')).resolves.toBe(
      'master',
    );
  });
});
