import { describe, expect, it } from 'vitest';
import {
  ASK_TOOL,
  mapPolicyToClaude,
  mapPolicyToCodex,
  mapPolicyToPi,
  policyForStage,
} from './policy.js';

/**
 * Regression guard: the capability refactor must reproduce the ORIGINAL
 * hand-written Claude tool lists exactly. These expected values are copied from
 * the pre-refactor `STAGE_TOOL_POLICY`. If a capability mapping drifts, the
 * Claude adapter's behavior changes — these tests catch it.
 */
describe('mapPolicyToClaude reproduces the original Claude tool lists', () => {
  const claudeFor = (stage: string) => mapPolicyToClaude(policyForStage(stage));

  it('task_brief — research only, code-read + mutation + escape hard-denied, plan mode', () => {
    const p = claudeFor('task_brief');
    expect(p.allowedTools).toEqual([
      'WebFetch',
      'WebSearch',
      'mcp__linear-server',
      'mcp__sentry',
      'mcp__atlassian',
    ]);
    expect(p.disallowedTools).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
      'Skill',
      'Monitor',
      'ToolSearch',
      'ExitPlanMode',
      'KillShell',
      'Read',
      'Grep',
      'Glob',
    ]);
    expect(p.permissionMode).toBe('plan');
  });

  it('discovery — read + ask + Klaviyo context, READ_ONLY_DENY, plan mode', () => {
    const p = claudeFor('discovery');
    expect(p.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      ASK_TOOL,
      'mcp__linear-server',
      'mcp__sentry',
    ]);
    expect(p.disallowedTools).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
      'Skill',
      'Monitor',
      'ToolSearch',
      'ExitPlanMode',
      'KillShell',
    ]);
    expect(p.permissionMode).toBe('plan');
  });

  it('implementation — read/edit/write/bash, nothing denied, acceptEdits', () => {
    const p = claudeFor('implementation');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    expect(p.disallowedTools).toEqual([]);
    expect(p.permissionMode).toBe('acceptEdits');
  });

  it('delivery_conflict — same edit/bash policy as implementation', () => {
    const p = claudeFor('delivery_conflict');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    expect(p.disallowedTools).toEqual([]);
    expect(p.permissionMode).toBe('acceptEdits');
  });

  it('feature_e2e — read/bash/write/Task, Edit+NotebookEdit denied (Write kept), default', () => {
    const p = claudeFor('feature_e2e');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Task']);
    expect(p.disallowedTools).toEqual(['Edit', 'NotebookEdit']);
    expect(p.disallowedTools).not.toContain('Write');
    expect(p.permissionMode).toBe('default');
  });

  it('agent_self_review — read/bash/Task, file mutation denied, default', () => {
    const p = claudeFor('agent_self_review');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Task']);
    expect(p.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(p.permissionMode).toBe('default');
  });

  it('delivery_prep — read/bash, file mutation denied, default', () => {
    const p = claudeFor('delivery_prep');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(p.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(p.permissionMode).toBe('default');
  });

  it('project_memory_summary — no tools, READ_ONLY_DENY, default (not plan)', () => {
    const p = claudeFor('project_memory_summary');
    expect(p.allowedTools).toEqual([]);
    expect(p.disallowedTools).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
      'Skill',
      'Monitor',
      'ToolSearch',
      'ExitPlanMode',
      'KillShell',
    ]);
    expect(p.permissionMode).toBe('default');
  });

  it('unknown stage falls back to read-only/plan', () => {
    const p = claudeFor('some_unknown_stage');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(p.disallowedTools).toEqual([
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
      'Skill',
      'Monitor',
      'ToolSearch',
      'ExitPlanMode',
      'KillShell',
    ]);
    expect(p.permissionMode).toBe('plan');
  });
});

describe('mapPolicyToPi maps capabilities to Pi tool names', () => {
  const piFor = (stage: string) => mapPolicyToPi(policyForStage(stage));

  it('discovery — read-only tools, edit/write/bash excluded', () => {
    const p = piFor('discovery');
    expect(p.tools).toEqual(['read', 'grep', 'find', 'ls']);
    expect(p.excludeTools).toEqual(['edit', 'write', 'bash']);
  });

  it('implementation — read + edit/write + bash, nothing excluded', () => {
    const p = piFor('implementation');
    expect(p.tools).toEqual(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
    expect(p.excludeTools).toEqual([]);
  });

  it('feature_e2e — write (no edit) granted; edit excluded, write kept', () => {
    const p = piFor('feature_e2e');
    expect(p.tools).toEqual(['read', 'grep', 'find', 'ls', 'write', 'bash']);
    expect(p.tools).toContain('write');
    expect(p.excludeTools).toEqual(['edit']);
  });

  it('agent_self_review — read + bash, edit/write excluded', () => {
    const p = piFor('agent_self_review');
    expect(p.tools).toEqual(['read', 'grep', 'find', 'ls', 'bash']);
    expect(p.excludeTools).toEqual(['edit', 'write']);
  });

  it('task_brief — research has no Pi peer, so no tools granted', () => {
    const p = piFor('task_brief');
    expect(p.tools).toEqual([]);
    expect(p.excludeTools).toEqual(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
  });

  it('project_memory_summary — no tools', () => {
    const p = piFor('project_memory_summary');
    expect(p.tools).toEqual([]);
  });
});

describe('mapPolicyToCodex maps capabilities to sandbox modes', () => {
  const codexFor = (stage: string) => mapPolicyToCodex(policyForStage(stage));

  it('read-only stages (brief/discovery/review/prep) — read-only sandbox', () => {
    for (const stage of ['task_brief', 'discovery', 'agent_self_review', 'delivery_prep']) {
      expect(codexFor(stage).sandbox).toBe('read-only');
    }
  });

  it('mutating stages (implementation/conflict) — workspace-write', () => {
    expect(codexFor('implementation').sandbox).toBe('workspace-write');
    expect(codexFor('delivery_conflict').sandbox).toBe('workspace-write');
  });

  it('feature_e2e — write capability forces workspace-write (documented softening)', () => {
    expect(codexFor('feature_e2e').sandbox).toBe('workspace-write');
  });

  it('research capability enables web search (brief/discovery only)', () => {
    expect(codexFor('task_brief').webSearch).toBe(true);
    expect(codexFor('discovery').webSearch).toBe(true);
    expect(codexFor('implementation').webSearch).toBe(false);
    expect(codexFor('agent_self_review').webSearch).toBe(false);
  });
});
