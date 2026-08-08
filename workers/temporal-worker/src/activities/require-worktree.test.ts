import { describe, expect, it } from 'vitest';
import { runtimeProfile } from '@awb/agent-gateway';
import { requireWorktreeCwd } from './run-phase.js';

describe('requireWorktreeCwd (TASK-31/38: no process.cwd() drift on a real-worktree runtime)', () => {
  it('returns the worktree path on a real-worktree runtime when set', () => {
    expect(requireWorktreeCwd(runtimeProfile('claude'), '/tmp/worktree', 'verify', 'task-1')).toBe('/tmp/worktree');
  });

  it('throws on a real-worktree runtime when the path is unset (never falls back to process.cwd())', () => {
    expect(() => requireWorktreeCwd(runtimeProfile('claude'), undefined, 'verify', 'task-1')).toThrow(
      /requires runState\.worktreePath/,
    );
  });

  it('applies to ANY real-worktree runtime, not just claude (profile-driven, no vendor string)', () => {
    // A non-claude real runtime takes the same loud-failure branch, keyed on the profile.
    expect(() => requireWorktreeCwd(runtimeProfile('codex'), undefined, 'verify', 'task-1')).toThrow(
      /the codex runtime requires runState\.worktreePath/,
    );
  });

  it('falls back to process.cwd() on the mock runtime (deterministic tests unchanged)', () => {
    expect(requireWorktreeCwd(runtimeProfile('mock'), undefined, 'verify', 'task-1')).toBe(process.cwd());
  });

  it('still prefers an explicit worktree path on the mock runtime when provided', () => {
    expect(requireWorktreeCwd(runtimeProfile('mock'), '/tmp/fixture-repo', 'exercise', 'task-1')).toBe('/tmp/fixture-repo');
  });
});
