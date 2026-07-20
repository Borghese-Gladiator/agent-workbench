import { describe, expect, it } from 'vitest';
import { resolveTaskBranchName } from './branch.js';

describe('resolveTaskBranchName', () => {
  it('produces a kebab-case, alphanumeric-only slug prefixed with awb/<taskId>-', () => {
    const branch = resolveTaskBranchName('task-123', 'Add OAuth Login Flow!');
    expect(branch).toBe('awb/task-123-add-oauth-login-flow');
  });

  it('strips non-alphanumeric characters and collapses whitespace/punctuation runs', () => {
    const branch = resolveTaskBranchName('t1', 'Fix bug: null pointer @ line 42!!');
    expect(branch).toBe('awb/t1-fix-bug-null-pointer-line-42');
  });

  it('truncates long slug sources to a bounded length', () => {
    const longPrompt = 'a'.repeat(200);
    const branch = resolveTaskBranchName('t1', longPrompt);
    const slug = branch.replace('awb/t1-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a default slug when the source has no alphanumeric content', () => {
    const branch = resolveTaskBranchName('t1', '!!!???');
    expect(branch).toBe('awb/t1-task');
  });

  it('produces distinct branch names for distinct task ids given the same slug source', () => {
    const a = resolveTaskBranchName('task-a', 'same prompt');
    const b = resolveTaskBranchName('task-b', 'same prompt');
    expect(a).not.toBe(b);
  });
});
