import { describe, expect, it } from 'vitest';
import { capabilitiesToCodexSandbox } from './codex-sandbox.js';

describe('capabilitiesToCodexSandbox', () => {
  it('a builder (worktree.write) gets a writable sandbox', () => {
    const policy = capabilitiesToCodexSandbox(['repository.read', 'worktree.write', 'command.run-scoped']);
    expect(policy.sandbox).toBe('workspace-write');
  });

  it('worktree.patch alone also warrants a writable sandbox', () => {
    expect(capabilitiesToCodexSandbox(['repository.read', 'worktree.patch']).sandbox).toBe('workspace-write');
  });

  it('a read-only role (no mutating capability) runs read-only', () => {
    expect(capabilitiesToCodexSandbox(['repository.read', 'repository.search', 'diff.read']).sandbox).toBe('read-only');
  });

  it('holding shell (command.run-scoped) without mutation is still read-only — commands run, writes blocked', () => {
    expect(capabilitiesToCodexSandbox(['repository.read', 'command.run-scoped']).sandbox).toBe('read-only');
  });

  it('an empty grant is read-only, and web search is off (no active research capability)', () => {
    const policy = capabilitiesToCodexSandbox([]);
    expect(policy.sandbox).toBe('read-only');
    expect(policy.webSearch).toBe(false);
  });
});
