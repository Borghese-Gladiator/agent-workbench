import { describe, expect, it } from 'vitest';
import { capabilitiesToSdkTools } from './capability-tools.js';

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
