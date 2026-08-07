/**
 * Maps the workbench's abstract capability names (from `@awb/capability-broker`) to the Pi Coding
 * Agent's built-in tool surface (`pi --tools` / `--exclude-tools`), the Pi analogue of
 * `capabilitiesToSdkTools` for Claude.
 *
 * WHY THIS EXISTS: Pi's `--mode json` path is non-interactive — there is NO mid-run permission
 * prompt and NO permission-mode concept. The capability boundary therefore has to be enforced
 * STRUCTURALLY: a tool the role wasn't granted must simply not exist for the run. `--tools` is the
 * closed allowlist (the only built-ins the run may use) and `--exclude-tools` is the explicit
 * complement, so a read-only role provably cannot `edit`/`write`/`bash`. Passing the abstract
 * capability strings straight to `--tools` would name tools Pi doesn't have, granting nothing.
 *
 * Pi's built-in surface has no Task/Monitor/Skill orchestration tools, so the escape-tool boundary
 * (a concern on the Claude SDK path) is satisfied for free by the allowlist being closed — there is
 * nothing extra to deny.
 */

/** Pi's built-in tool names (see `pi --tools` / `--exclude-tools`). */
export type PiToolName = 'read' | 'grep' | 'find' | 'ls' | 'edit' | 'write' | 'bash';

/** Every built-in Pi tool — the domain over which the allow/exclude split is computed. */
export const ALL_PI_TOOLS: readonly PiToolName[] = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'];

const CAPABILITY_TO_PI_TOOLS: Record<string, PiToolName[]> = {
  // Read/search a checkout or worktree → Pi's read/search built-ins.
  'repository.read': ['read', 'ls'],
  'repository.list': ['ls', 'find'],
  'repository.search': ['grep', 'find'],
  'repository.symbols': ['grep'],
  'repository.dependencies': ['read'],
  'repository.tests': ['read', 'find'],
  'repository.commands': ['read'],
  'worktree.read': ['read', 'ls'],
  'contract.read': ['read'],
  'plan.read': ['read'],
  'verification.read': ['read'],
  'qa-evidence.read': ['read'],
  'merged-repository.read': ['read', 'ls'],
  'task-contract.read': ['read'],
  'findings.read': ['read'],
  'evidence.read': ['read'],
  'memory.query': ['read'],
  // Git inspection + diff reads run through the shell (Pi has no dedicated git tool).
  'diff.read': ['bash'],
  'final-diff.read': ['bash'],
  'git.log': ['bash'],
  'git.diff': ['bash'],
  'git.blame': ['bash'],
  // Mutating a worktree: the builder gets the file-editing tools plus scoped shell.
  'worktree.write': ['edit', 'write'],
  'worktree.patch': ['edit'],
  'command.run-scoped': ['bash'],
  'targeted-test.run': ['bash'],
  'configured-check.run': ['bash'],
  // Reviewer probes run commands.
  'probe.request': ['bash'],
};

/** The Pi tool lists a role's granted capabilities resolve to. */
export interface PiToolPolicy {
  /** `--tools` allowlist: the ONLY built-in tools the run may use. */
  tools: PiToolName[];
  /** `--exclude-tools` hard-deny: the complement over {@link ALL_PI_TOOLS}, for explicit closure. */
  excludeTools: PiToolName[];
}

/**
 * Translate a role's granted capabilities into Pi's `--tools`/`--exclude-tools` policy. Capabilities
 * with no built-in Pi equivalent (the `finding.write`/`evidence.write` writes serviced by
 * deterministic code, the `browser.*`/`github.*` families, or `research`/`ask`/`subagent` which Pi's
 * `--mode json` path has no tool for) contribute nothing — a documented gap, same as the Claude
 * mapper. An empty grant yields an empty allowlist and a full exclude list (a no-tool run).
 */
export function capabilitiesToPiTools(capabilities: readonly string[]): PiToolPolicy {
  const tools = new Set<PiToolName>();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TO_PI_TOOLS[capability] ?? []) {
      tools.add(tool);
    }
  }
  const allow = ALL_PI_TOOLS.filter((t) => tools.has(t));
  return {
    tools: allow,
    excludeTools: ALL_PI_TOOLS.filter((t) => !tools.has(t)),
  };
}
