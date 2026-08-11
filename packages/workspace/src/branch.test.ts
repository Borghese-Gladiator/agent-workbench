import { describe, expect, it } from 'vitest';
import { resolveTaskBranchName, resolveWorktreeDirName } from './branch.js';

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
    // The "In <scope>," preamble is stripped, so the slug leads with the ACTION.
    const branch = resolveTaskBranchName(uuid, 'In the portal header, show the number of available games');
    expect(branch).toBe('awb/show-the-number-of-available-games-ecabb015');
    expect(branch).not.toContain(uuid);
  });

  // No leading `in-` and no repo-name filler for an "In <repo>, <action>" prompt.
  it('strips the "In <scope>," preamble so the branch reads as the action', () => {
    const branch = resolveTaskBranchName('f47a0d8e-1111-2222-3333-444455556666', 'In wip-browser-games, add a one-line note');
    expect(branch).toBe('awb/add-a-one-line-note-f47a0d8e');
    expect(branch.startsWith('awb/in-')).toBe(false);
    expect(branch).not.toContain('wip-browser-games');
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

describe('resolveWorktreeDirName', () => {
  it('mirrors the branch slug/short-id without the `awb/` prefix so the dir is a valid path segment', () => {
    const dirName = resolveWorktreeDirName('task-123', 'Add OAuth Login Flow!');
    expect(dirName).toBe('add-oauth-login-flow-task123');
    expect(dirName).not.toContain('/');
    expect(resolveTaskBranchName('task-123', 'Add OAuth Login Flow!')).toBe(`awb/${dirName}`);
  });

  it('does not dump a full UUID into the directory name', () => {
    const uuid = 'ecabb015-d40d-409a-82c3-82fce7bee7b9';
    const dirName = resolveWorktreeDirName(uuid, 'In the portal header, show the number of available games');
    expect(dirName).toBe('show-the-number-of-available-games-ecabb015');
    expect(dirName).not.toContain(uuid);
  });

  it('produces distinct directory names for distinct task ids given the same slug source', () => {
    const a = resolveWorktreeDirName('task-a', 'same prompt');
    const b = resolveWorktreeDirName('task-b', 'same prompt');
    expect(a).not.toBe(b);
  });
});
