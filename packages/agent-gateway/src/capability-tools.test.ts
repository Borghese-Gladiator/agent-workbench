import { describe, expect, it } from 'vitest';
import { capabilitiesToSdkTools, disallowedSdkTools, ALL_SDK_TOOLS } from './capability-tools.js';

describe('capabilitiesToSdkTools', () => {
  it('maps builder capabilities to the concrete file + shell SDK tools', () => {
    const tools = capabilitiesToSdkTools([
      'repository.read',
      'repository.search',
      'worktree.write',
      'worktree.patch',
      'command.run-scoped',
      'targeted-test.run',
      'diff.read',
    ]);
    // The builder must be able to read, write, edit, and run scoped commands.
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']));
  });

  it('maps planner read-only capabilities to read/search tools without Write/Edit', () => {
    const tools = capabilitiesToSdkTools(['repository.read', 'repository.search', 'git.log', 'contract.read']);
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash']));
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });

  it('dedupes and ignores capabilities with no SDK-tool mapping', () => {
    const tools = capabilitiesToSdkTools(['repository.read', 'repository.read', 'finding.write', 'evidence.write']);
    expect(tools).toEqual(['Read', 'Glob']);
  });

  it('returns an empty list for capabilities serviced by non-core surfaces only', () => {
    expect(capabilitiesToSdkTools(['browser.navigate', 'github.create-draft-pr'])).toEqual([]);
  });
});

describe('disallowedSdkTools (TASK-24 enforcement)', () => {
  it('denies Write/Edit/Bash for a read-only role (planner)', () => {
    const denied = disallowedSdkTools(['repository.read', 'repository.search', 'contract.read']);
    expect(denied).toContain('Write');
    expect(denied).toContain('Edit');
    // planner has no Bash-mapped capability here, so Bash is denied too
    expect(denied).toContain('Bash');
    // ...but the tools it IS granted are not denied
    expect(denied).not.toContain('Read');
    expect(denied).not.toContain('Grep');
    expect(denied).not.toContain('Glob');
  });

  it('does not deny Write/Edit/Bash for the builder (which is granted them)', () => {
    const denied = disallowedSdkTools([
      'repository.read',
      'worktree.write',
      'worktree.patch',
      'command.run-scoped',
    ]);
    expect(denied).not.toContain('Write');
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Bash');
  });

  it('allowed and disallowed together partition the full tool universe with no overlap', () => {
    const caps = ['repository.read', 'worktree.write'];
    const allowed = new Set(capabilitiesToSdkTools(caps));
    const denied = new Set(disallowedSdkTools(caps));
    // No tool is both allowed and denied.
    for (const t of allowed) expect(denied.has(t)).toBe(false);
    // Every core tool is in exactly one of the two sets.
    for (const t of ALL_SDK_TOOLS) expect(allowed.has(t) || denied.has(t)).toBe(true);
    expect(allowed.size + denied.size).toBe(ALL_SDK_TOOLS.length);
  });
});
