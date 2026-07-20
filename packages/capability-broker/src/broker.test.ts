import { describe, expect, it } from 'vitest';
import { createCapabilityBroker, CapabilityDeniedError } from './broker.js';
import type { AgentRole, Capability } from './roles.js';

describe('CapabilityBroker — positive grants per role', () => {
  const expectedGrants: Record<AgentRole, Capability[]> = {
    planner: ['repository.read', 'repository.search', 'git.log', 'memory.query', 'contract.read'],
    'plan-critic': ['contract.read', 'plan.read', 'repository.read', 'finding.write'],
    builder: ['worktree.write', 'worktree.patch', 'command.run-scoped', 'targeted-test.run', 'diff.read'],
    verifier: ['worktree.read', 'configured-check.run', 'test-report.write', 'evidence.write'],
    'qa-executor': ['browser.navigate', 'browser.record', 'terminal.interact', 'http.request', 'evidence.write'],
    'adversarial-reviewer': ['diff.read', 'contract.read', 'plan.read', 'finding.write', 'probe.request'],
    'memory-curator': ['merged-repository.read', 'task-contract.read', 'final-diff.read', 'local-memory.write'],
    'delivery-adapter': ['git.push', 'github.create-draft-pr', 'github.upload-media'],
  };

  for (const [role, capabilities] of Object.entries(expectedGrants) as [AgentRole, Capability[]][]) {
    for (const capability of capabilities) {
      it(`${role} is granted ${capability}`, () => {
        const broker = createCapabilityBroker(role);
        expect(broker.can(capability)).toBe(true);
        expect(() => broker.assert(capability)).not.toThrow();
      });
    }
  }
});

describe('CapabilityBroker — explicit denials from product spec §18 "No:" lists', () => {
  it('planner has no repository.write, no git push/commit-adjacent, no evidence.write, no browser, no command.run-scoped', () => {
    const broker = createCapabilityBroker('planner');
    // repository.write and generic shell are not part of the capability union at all (they were
    // never defined), which itself proves no role can be granted them; here we check the
    // specific capabilities the planner must not have among those that DO exist for other roles.
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('command.run-scoped')).toBe(false);
    expect(broker.can('git.push')).toBe(false);
    expect(broker.can('browser.navigate')).toBe(false);
    expect(broker.can('evidence.write')).toBe(false);
  });

  it('plan-critic is read-only plus finding.write — no worktree or command access', () => {
    const broker = createCapabilityBroker('plan-critic');
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('command.run-scoped')).toBe(false);
    expect(broker.can('git.push')).toBe(false);
  });

  it('builder has no GitHub credentials, no git.push, no PR creation, no project-memory writes', () => {
    const broker = createCapabilityBroker('builder');
    expect(broker.can('git.push')).toBe(false);
    expect(broker.can('github.create-draft-pr')).toBe(false);
    expect(broker.can('local-memory.write')).toBe(false);
  });

  it('verifier cannot edit code (no worktree.write/worktree.patch)', () => {
    const broker = createCapabilityBroker('verifier');
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('worktree.patch')).toBe(false);
  });

  it('qa-executor has no source writes', () => {
    const broker = createCapabilityBroker('qa-executor');
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('worktree.patch')).toBe(false);
  });

  it('adversarial-reviewer is read-only plus finding.write and probe.request — cannot edit code', () => {
    const broker = createCapabilityBroker('adversarial-reviewer');
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('command.run-scoped')).toBe(false);
  });

  it('agent sessions never receive GitHub credentials — only delivery-adapter has github.* capabilities', () => {
    const agentRoles: AgentRole[] = ['planner', 'plan-critic', 'builder', 'verifier', 'qa-executor', 'adversarial-reviewer'];
    for (const role of agentRoles) {
      const broker = createCapabilityBroker(role);
      expect(broker.can('git.push')).toBe(false);
      expect(broker.can('github.create-draft-pr')).toBe(false);
      expect(broker.can('github.upload-media')).toBe(false);
    }
  });

  it('memory-curator runs after merge and cannot write worktree/run commands', () => {
    const broker = createCapabilityBroker('memory-curator');
    expect(broker.can('worktree.write')).toBe(false);
    expect(broker.can('command.run-scoped')).toBe(false);
    expect(broker.can('git.push')).toBe(false);
  });
});

describe('CapabilityBroker — assert throws a typed, informative error on denial', () => {
  it('throws CapabilityDeniedError naming the role and capability', () => {
    const broker = createCapabilityBroker('planner');
    try {
      broker.assert('worktree.write');
      expect.unreachable('assert should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError);
      const denied = err as CapabilityDeniedError;
      expect(denied.role).toBe('planner');
      expect(denied.capability).toBe('worktree.write');
      expect(denied.message).toContain('planner');
      expect(denied.message).toContain('worktree.write');
    }
  });
});

describe('CapabilityBroker — listGranted', () => {
  it('returns exactly the capabilities in the table for a role, no more no less', () => {
    const broker = createCapabilityBroker('verifier');
    expect([...broker.listGranted()].sort()).toEqual(
      ['worktree.read', 'configured-check.run', 'test-report.write', 'evidence.write'].sort(),
    );
  });
});
