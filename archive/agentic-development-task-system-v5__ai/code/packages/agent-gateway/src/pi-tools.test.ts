import { describe, expect, it } from 'vitest';
import { ALL_PI_TOOLS, capabilitiesToPiTools } from './pi-tools.js';

describe('capabilitiesToPiTools', () => {
  it('maps read-only capabilities to read tools and hard-denies edit/write/bash', () => {
    const policy = capabilitiesToPiTools(['repository.read', 'repository.search', 'contract.read']);
    expect(policy.tools).toEqual(expect.arrayContaining(['read', 'ls', 'grep', 'find']));
    expect(policy.tools).not.toContain('edit');
    expect(policy.tools).not.toContain('write');
    expect(policy.tools).not.toContain('bash');
    // The exclude list is the exact complement, so a read-only role provably cannot mutate.
    expect(policy.excludeTools).toEqual(expect.arrayContaining(['edit', 'write', 'bash']));
  });

  it('grants edit/write for a worktree-writing builder role', () => {
    const policy = capabilitiesToPiTools(['repository.read', 'worktree.write', 'command.run-scoped']);
    expect(policy.tools).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'bash']));
    expect(policy.excludeTools).not.toContain('edit');
    expect(policy.excludeTools).not.toContain('bash');
  });

  it('maps git/diff reads to bash (Pi has no dedicated git tool)', () => {
    const policy = capabilitiesToPiTools(['git.diff', 'diff.read']);
    expect(policy.tools).toContain('bash');
    expect(policy.tools).not.toContain('edit');
  });

  it('an empty grant yields a no-tool run (empty allow, full exclude)', () => {
    const policy = capabilitiesToPiTools([]);
    expect(policy.tools).toEqual([]);
    expect(policy.excludeTools).toEqual([...ALL_PI_TOOLS]);
  });

  it('allow and exclude partition the full tool universe with no overlap', () => {
    const policy = capabilitiesToPiTools(['repository.read', 'worktree.patch']);
    const union = new Set([...policy.tools, ...policy.excludeTools]);
    expect(union.size).toBe(ALL_PI_TOOLS.length);
    for (const t of policy.tools) expect(policy.excludeTools).not.toContain(t);
  });
});
