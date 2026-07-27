import { describe, expect, it } from 'vitest';
import { requireWorktreeCwd } from './run-phase.js';

describe('requireWorktreeCwd (TASK-31: no process.cwd() drift on the real path)', () => {
  it('returns the worktree path on the claude runtime when set', () => {
    expect(requireWorktreeCwd('claude', '/tmp/worktree', 'verify', 'task-1')).toBe('/tmp/worktree');
  });

  it('throws on the claude runtime when the worktree path is unset (never falls back to process.cwd())', () => {
    expect(() => requireWorktreeCwd('claude', undefined, 'verify', 'task-1')).toThrow(
      /claude runtime requires runState.worktreePath/,
    );
  });

  it('falls back to process.cwd() on the mock runtime (deterministic tests unchanged)', () => {
    expect(requireWorktreeCwd('mock', undefined, 'verify', 'task-1')).toBe(process.cwd());
  });

  it('still prefers an explicit worktree path on the mock runtime when provided', () => {
    expect(requireWorktreeCwd('mock', '/tmp/fixture-repo', 'exercise', 'task-1')).toBe('/tmp/fixture-repo');
  });
});
