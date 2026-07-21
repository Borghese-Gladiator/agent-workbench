/**
 * Maps the workbench's abstract capability names (from `@awb/capability-broker`, product spec §18)
 * to the concrete Claude Agent SDK tool names the session must be granted via the SDK's `tools`
 * option.
 *
 * WHY THIS EXISTS: the capability broker speaks in intent — `worktree.write`, `repository.read`,
 * `command.run-scoped` — but the SDK's `tools` option expects real tool names (`Write`, `Read`,
 * `Bash`, …). Passing the abstract names straight through means the SDK recognizes none of them,
 * the agent gets NO core file tools, and (because `tools: []`-equivalent falls through to ambient
 * inheritance) the session leaks in whatever MCP servers happen to be configured in the environment
 * instead. That was the observed live failure: the builder session had only Buildkite/Chronosphere/
 * Figma/Playwright/Sentry MCP tools, could not Read/Write/Edit any file, produced no diff, and the
 * implement phase stalled as `repeated-failure-no-progress`.
 */
export type SdkToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Grep'
  | 'Glob'
  | 'Bash'
  | 'WebFetch'
  | 'WebSearch';

const CAPABILITY_TO_SDK_TOOLS: Record<string, SdkToolName[]> = {
  // Read/search a checkout or worktree.
  'repository.read': ['Read', 'Glob'],
  'repository.list': ['Glob'],
  'repository.search': ['Grep', 'Glob'],
  'repository.symbols': ['Grep'],
  'repository.dependencies': ['Read'],
  'repository.tests': ['Read', 'Glob'],
  'repository.commands': ['Read'],
  'worktree.read': ['Read', 'Glob'],
  'diff.read': ['Bash'],
  'contract.read': ['Read'],
  'plan.read': ['Read'],
  'verification.read': ['Read'],
  'qa-evidence.read': ['Read'],
  'merged-repository.read': ['Read', 'Glob'],
  'task-contract.read': ['Read'],
  'final-diff.read': ['Bash'],
  'findings.read': ['Read'],
  'evidence.read': ['Read'],
  // Git inspection maps to Bash (git subcommands), the only SDK surface for it.
  'git.log': ['Bash'],
  'git.diff': ['Bash'],
  'git.blame': ['Bash'],
  // Mutating a worktree: the builder needs the file-editing tools plus scoped shell.
  'worktree.write': ['Write', 'Edit'],
  'worktree.patch': ['Edit'],
  'command.run-scoped': ['Bash'],
  'targeted-test.run': ['Bash'],
  'configured-check.run': ['Bash'],
  // Reviewer probes.
  'probe.request': ['Bash'],
  'memory.query': ['Read'],
};

/**
 * Translates a role's granted capabilities into the deduped set of concrete SDK tool names to pass
 * as the session's `tools`. Capabilities with no SDK-tool mapping (e.g. `finding.write`,
 * `evidence.write`, the `browser.*`/`github.*`/`application.*` families that are serviced by
 * deterministic code or dedicated MCP surfaces rather than core tools) simply contribute nothing.
 */
export function capabilitiesToSdkTools(capabilities: readonly string[]): SdkToolName[] {
  const tools = new Set<SdkToolName>();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TO_SDK_TOOLS[capability] ?? []) {
      tools.add(tool);
    }
  }
  return [...tools];
}
