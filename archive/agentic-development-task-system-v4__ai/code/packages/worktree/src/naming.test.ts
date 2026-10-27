import { describe, expect, it } from 'vitest';
import { branchFor, slugify, worktreePathFor } from './naming.js';

describe('naming rules', () => {
  it('slugifies titles to lowercase hyphenated ascii', () => {
    expect(slugify('Add Dark Mode!')).toBe('add-dark-mode');
    expect(slugify('  Trailing / slashes  ')).toBe('trailing-slashes');
    expect(slugify('')).toBe('task');
  });

  it('branch leads with the slug and ends with a short id: <slug>-<short-id>', () => {
    // Readable summary first; short id suffix (last 6 of the nanoid) for
    // uniqueness. No workbench namespace prefix — reads as a normal feature branch.
    expect(branchFor('task_V1StGXR8Z5', 'Add Dark Mode')).toBe('add-dark-mode-GXR8Z5');
  });

  it('short id falls back to the whole id when there is no prefix', () => {
    expect(branchFor('abc', 'Fix bug')).toBe('fix-bug-abc');
  });

  it('worktree path sits beside the project repo, scoped by repo basename', () => {
    expect(worktreePathFor('/Users/me/GitHub/carshare-pwa', 'task_x', 'Fix the bug')).toBe(
      '/Users/me/GitHub/.workbench-worktrees/carshare-pwa/task_x-fix-the-bug',
    );
  });

  it('worktree path is never nested inside the workbench data dir', () => {
    const path = worktreePathFor('/Users/me/GitHub/carshare-pwa', 'task_y', 'Add feature');
    expect(path.includes('/agent-workbench/data/worktrees')).toBe(false);
    expect(path.startsWith('/Users/me/GitHub/.workbench-worktrees/')).toBe(true);
  });
});
