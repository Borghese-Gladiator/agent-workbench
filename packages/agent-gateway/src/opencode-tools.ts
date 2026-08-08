/**
 * Maps the workbench's abstract capability names (from `@awb/capability-broker`) to an OpenCode
 * agent `permission` block — the OpenCode analogue of `capabilitiesToPiTools` / `capabilitiesToSdkTools`.
 *
 * WHY THIS EXISTS: `opencode run` has no per-invocation `--tools`/`--deny` flag (unlike Pi). Its
 * tool boundary is defined by an AGENT, whose markdown frontmatter carries a `permission:` map of
 * `tool -> allow | deny`. `opencode run --agent <name>` runs under that agent. The adapter therefore
 * MATERIALIZES an ephemeral per-role agent file (see opencode-adapter.ts) from the map this module
 * computes, instead of `--dangerously-skip-permissions` which auto-approves EVERYTHING and let a
 * read-only role mutate the worktree.
 *
 * OpenCode's built-in tool universe (from `opencode agent create --permissions`):
 *   bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill
 */

export type OpenCodeTool =
  | 'bash'
  | 'read'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'webfetch'
  | 'task'
  | 'todowrite'
  | 'websearch'
  | 'lsp'
  | 'skill';

export type OpenCodePermission = 'allow' | 'deny';

/** Every OpenCode built-in tool — the domain the permission map must cover in full. */
export const ALL_OPENCODE_TOOLS: readonly OpenCodeTool[] = [
  'bash',
  'read',
  'edit',
  'glob',
  'grep',
  'webfetch',
  'task',
  'todowrite',
  'websearch',
  'lsp',
  'skill',
];

/** Which OpenCode tools each abstract capability unlocks. */
const CAPABILITY_TO_OPENCODE_TOOLS: Record<string, OpenCodeTool[]> = {
  'repository.read': ['read', 'glob'],
  'repository.list': ['glob'],
  'repository.search': ['grep', 'glob'],
  'repository.symbols': ['grep', 'lsp'],
  'repository.dependencies': ['read'],
  'repository.tests': ['read', 'glob'],
  'repository.commands': ['read'],
  'worktree.read': ['read', 'glob'],
  'contract.read': ['read'],
  'plan.read': ['read'],
  'verification.read': ['read'],
  'qa-evidence.read': ['read'],
  'merged-repository.read': ['read', 'glob'],
  'task-contract.read': ['read'],
  'findings.read': ['read'],
  'evidence.read': ['read'],
  'memory.query': ['read'],
  // Git inspection + diff reads go through the shell.
  'diff.read': ['bash'],
  'final-diff.read': ['bash'],
  'git.log': ['bash'],
  'git.diff': ['bash'],
  'git.blame': ['bash'],
  // Mutating a worktree.
  'worktree.write': ['edit'],
  'worktree.patch': ['edit'],
  'command.run-scoped': ['bash'],
  'targeted-test.run': ['bash'],
  'configured-check.run': ['bash'],
  'probe.request': ['bash'],
};

/**
 * Compute the full `tool -> allow|deny` permission map for a role's granted capabilities. Every tool
 * in {@link ALL_OPENCODE_TOOLS} is present (OpenCode leaves unlisted tools at their default, so an
 * explicit `deny` is required to actually withhold one). `task` (subagents) and `websearch`/
 * `webfetch` are always denied — the workbench grants no subagent or external-research capability.
 */
export function capabilitiesToOpenCodePermission(
  capabilities: readonly string[],
): Record<OpenCodeTool, OpenCodePermission> {
  const allowed = new Set<OpenCodeTool>();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TO_OPENCODE_TOOLS[capability] ?? []) {
      allowed.add(tool);
    }
  }
  const permission = {} as Record<OpenCodeTool, OpenCodePermission>;
  for (const tool of ALL_OPENCODE_TOOLS) {
    permission[tool] = allowed.has(tool) ? 'allow' : 'deny';
  }
  return permission;
}

/**
 * Render the ephemeral agent markdown OpenCode discovers (a `permission:` frontmatter block). Written
 * to `~/.config/opencode/agent/<name>.md` by the adapter and selected via `opencode run --agent`.
 */
export function renderOpenCodeAgentFile(name: string, capabilities: readonly string[]): string {
  const permission = capabilitiesToOpenCodePermission(capabilities);
  const lines = ALL_OPENCODE_TOOLS.map((tool) => `  ${tool}: ${permission[tool]}`);
  return [
    '---',
    `description: AWB role ${name} (capability-scoped, generated)`,
    'mode: primary',
    'permission:',
    ...lines,
    '---',
    `Agentic-workbench role \`${name}\`. Tool access is scoped to this role's granted capabilities.`,
    '',
  ].join('\n');
}
