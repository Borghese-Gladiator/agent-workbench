import { describe, expect, it } from 'vitest';
import { parseGitHubRemote } from './delivery-support.js';

describe('parseGitHubRemote (Fix 6: resolve real repo ref)', () => {
  it('parses an https remote and strips .git', () => {
    expect(parseGitHubRemote('https://github.com/Borghese-Gladiator/wip-browser-games.git')).toEqual({
      owner: 'Borghese-Gladiator',
      repo: 'wip-browser-games',
    });
  });

  it('parses an https remote without .git', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an ssh remote', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns undefined for a non-GitHub remote', () => {
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeUndefined();
    expect(parseGitHubRemote('')).toBeUndefined();
  });
});
