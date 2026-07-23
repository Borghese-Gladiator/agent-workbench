import { describe, expect, it } from 'vitest';
import { resolveTaskBranchName } from './branch.js';

describe('resolveTaskBranchName', () => {
  it('puts the human-readable slug first, then a short task-id suffix', () => {
    const branch = resolveTaskBranchName('task-123', 'Add OAuth Login Flow!');
    expect(branch).toBe('awb/add-oauth-login-flow-task123');
  });

  it('strips non-alphanumeric characters and collapses whitespace/punctuation runs', () => {
    const branch = resolveTaskBranchName('t1', 'Fix bug: null pointer @ line 42!!');
    expect(branch).toBe('awb/fix-bug-null-pointer-line-42-t1');
  });

  it('does not dump a full UUID (or double it) into the branch', () => {
    const uuid = 'ecabb015-d40d-409a-82c3-82fce7bee7b9';
    const branch = resolveTaskBranchName(uuid, 'In the portal header, show the number of available games');
    expect(branch).toBe('awb/in-the-portal-header-show-the-number-of-ecabb015');
    expect(branch).not.toContain(uuid);
  });

  it('truncates long slug sources to a bounded length', () => {
    const longPrompt = 'a'.repeat(200);
    const branch = resolveTaskBranchName('t1', longPrompt);
    const slug = branch.replace('awb/', '').replace('-t1', '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a default slug when the source has no alphanumeric content', () => {
    const branch = resolveTaskBranchName('t1', '!!!???');
    expect(branch).toBe('awb/task-t1');
  });

  it('produces distinct branch names for distinct task ids given the same slug source', () => {
    const a = resolveTaskBranchName('task-a', 'same prompt');
    const b = resolveTaskBranchName('task-b', 'same prompt');
    expect(a).not.toBe(b);
  });
});
