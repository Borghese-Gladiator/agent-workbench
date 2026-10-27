import type { AgentRole, Capability } from './roles.js';

/**
 * The per-role capability allowlist (product spec §18). This is the single source of truth —
 * `hasCapability`/`assertCapability` below only ever consult this table. No role gets a generic
 * unrestricted shell; every capability a role needs must be listed explicitly here.
 */
export const CAPABILITY_TABLE: Record<AgentRole, readonly Capability[]> = {
  planner: [
    'repository.read',
    'repository.list',
    'repository.search',
    'repository.symbols',
    'repository.dependencies',
    'repository.tests',
    'repository.commands',
    'git.log',
    'git.diff',
    'git.blame',
    'memory.query',
    'contract.read',
  ],
  'plan-critic': ['contract.read', 'plan.read', 'repository.read', 'repository.search', 'memory.query', 'finding.write'],
  builder: [
    'repository.read',
    'repository.search',
    'worktree.write',
    'worktree.patch',
    'command.run-scoped',
    'targeted-test.run',
    'diff.read',
  ],
  verifier: ['worktree.read', 'configured-check.run', 'test-report.write', 'evidence.write'],
  'qa-executor': [
    'browser.navigate',
    'browser.click',
    'browser.type',
    'browser.inspect-accessibility',
    'browser.record',
    'terminal.interact',
    'http.request',
    'application.start',
    'application.stop',
    'evidence.write',
  ],
  'adversarial-reviewer': [
    'repository.read',
    'repository.search',
    'diff.read',
    'contract.read',
    'plan.read',
    'verification.read',
    'qa-evidence.read',
    'finding.write',
    'probe.request',
  ],
  'memory-curator': [
    'merged-repository.read',
    'task-contract.read',
    'final-diff.read',
    'findings.read',
    'evidence.read',
    'local-memory.write',
  ],
  'delivery-adapter': [
    'git.push',
    'github.create-draft-pr',
    'github.update-pr',
    'github.post-comment',
    'github.upload-media',
    'github.read-feedback',
    'github.read-merge-status',
  ],
};

export function capabilitiesForRole(role: AgentRole): readonly Capability[] {
  return CAPABILITY_TABLE[role];
}

export function hasCapability(role: AgentRole, capability: Capability): boolean {
  return CAPABILITY_TABLE[role].includes(capability);
}
