import { describe, expect, it } from 'vitest';
import {
  ALL_OPENCODE_TOOLS,
  capabilitiesToOpenCodePermission,
  renderOpenCodeAgentFile,
} from './opencode-tools.js';

describe('capabilitiesToOpenCodePermission', () => {
  it('allows read tools + denies mutation for a read-only role', () => {
    const perm = capabilitiesToOpenCodePermission(['repository.read', 'repository.search']);
    expect(perm.read).toBe('allow');
    expect(perm.grep).toBe('allow');
    expect(perm.glob).toBe('allow');
    expect(perm.edit).toBe('deny');
    expect(perm.bash).toBe('deny');
  });

  it('allows edit + bash for a worktree-writing builder', () => {
    const perm = capabilitiesToOpenCodePermission(['repository.read', 'worktree.write', 'command.run-scoped']);
    expect(perm.edit).toBe('allow');
    expect(perm.bash).toBe('allow');
    expect(perm.read).toBe('allow');
  });

  it('always denies subagents (task) and external research (webfetch/websearch)', () => {
    const perm = capabilitiesToOpenCodePermission(['repository.read', 'worktree.write', 'command.run-scoped']);
    expect(perm.task).toBe('deny');
    expect(perm.webfetch).toBe('deny');
    expect(perm.websearch).toBe('deny');
  });

  it('covers every tool in the universe (explicit allow|deny, none omitted)', () => {
    const perm = capabilitiesToOpenCodePermission(['repository.read']);
    for (const tool of ALL_OPENCODE_TOOLS) {
      expect(perm[tool]).toMatch(/^(allow|deny)$/);
    }
  });

  it('an empty grant denies everything', () => {
    const perm = capabilitiesToOpenCodePermission([]);
    for (const tool of ALL_OPENCODE_TOOLS) expect(perm[tool]).toBe('deny');
  });
});

describe('renderOpenCodeAgentFile', () => {
  it('emits permission frontmatter OpenCode can parse', () => {
    const md = renderOpenCodeAgentFile('awb-x', ['repository.read', 'worktree.write']);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('permission:');
    expect(md).toContain('edit: allow');
    expect(md).toContain('bash: deny'); // no command.run-scoped granted
    expect(md).toContain('task: deny');
  });
});
