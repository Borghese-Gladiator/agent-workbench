/**
 * Every agent-facing role in the system. "delivery-adapter" and "memory-curator" are included
 * even though they are deterministic code rather than agent sessions (product spec §18) — they
 * still need an explicit capability set so nothing downstream has to special-case "not an agent."
 */
export type AgentRole =
  | 'planner'
  | 'plan-critic'
  | 'builder'
  | 'verifier'
  | 'qa-executor'
  | 'adversarial-reviewer'
  | 'memory-curator'
  | 'delivery-adapter';

/**
 * Every capability string referenced anywhere in the per-role tables (product spec §18). Kept
 * as a single closed union so a typo in a role table is a compile error, not a silent no-op.
 */
export type Capability =
  | 'repository.read'
  | 'repository.list'
  | 'repository.search'
  | 'repository.symbols'
  | 'repository.dependencies'
  | 'repository.tests'
  | 'repository.commands'
  | 'git.log'
  | 'git.diff'
  | 'git.blame'
  | 'memory.query'
  | 'contract.read'
  | 'plan.read'
  | 'finding.write'
  | 'worktree.write'
  | 'worktree.patch'
  | 'worktree.read'
  | 'command.run-scoped'
  | 'targeted-test.run'
  | 'diff.read'
  | 'configured-check.run'
  | 'test-report.write'
  | 'evidence.write'
  | 'browser.navigate'
  | 'browser.click'
  | 'browser.type'
  | 'browser.inspect-accessibility'
  | 'browser.record'
  | 'terminal.interact'
  | 'http.request'
  | 'application.start'
  | 'application.stop'
  | 'verification.read'
  | 'qa-evidence.read'
  | 'probe.request'
  | 'merged-repository.read'
  | 'task-contract.read'
  | 'final-diff.read'
  | 'findings.read'
  | 'evidence.read'
  | 'local-memory.write'
  | 'git.push'
  | 'github.create-draft-pr'
  | 'github.update-pr'
  | 'github.post-comment'
  | 'github.upload-media'
  | 'github.read-feedback'
  | 'github.read-merge-status';
