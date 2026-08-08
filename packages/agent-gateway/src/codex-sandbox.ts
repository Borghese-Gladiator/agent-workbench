/**
 * Maps the workbench's abstract capability names (from `@awb/capability-broker`) to the Codex CLI's
 * enforcement surface. Codex is the coarsest of the three CLI runtimes: it has NO per-tool
 * allow/exclude vocabulary (unlike Pi's `--tools`, or the Claude SDK's `disallowedTools`) — its
 * boundary is the OS `--sandbox` mode. So the capability set collapses to a single sandbox choice.
 *
 * WHY THIS EXISTS: the Codex adapter previously hard-coded `--sandbox workspace-write`, giving every
 * role write access regardless of its grant — a read-only role (planner, adversarial reviewer) could
 * mutate the worktree. Deriving the sandbox from the role's granted capabilities restores the
 * boundary: a role with no mutating capability runs `read-only`.
 *
 * IMPORTANT SOFTENING vs Pi/Claude: `read-only` still lets commands RUN (so a reviewer can
 * `git diff`, run tests) — it blocks filesystem WRITES, not execution. Codex cannot deny `shell`
 * independently, and cannot express Pi's "write scratch files but never edit source" split. This is
 * a documented coarsening inherent to Codex's sandbox model, not a mapping bug.
 */

/** The mutating capabilities: any of these requires a writable sandbox. */
const MUTATING_CAPABILITIES = new Set<string>([
  'worktree.write',
  'worktree.patch',
]);

/** The Codex CLI enforcement a role's granted capabilities resolve to. */
export interface CodexSandboxPolicy {
  /**
   * `--sandbox` mode. `read-only` blocks all filesystem writes (but still runs commands);
   * `workspace-write` allows writes inside the cwd. Any mutating capability → `workspace-write`.
   */
  sandbox: 'read-only' | 'workspace-write';
  /**
   * Whether to enable Codex's built-in web-search tool. No active workbench role is granted an
   * external-research capability, so this is `false` today — kept as an explicit field so a future
   * research grant has one obvious place to flip it.
   */
  webSearch: boolean;
}

/**
 * Translate a role's granted capabilities into Codex's sandbox policy. `workspace-write` iff the role
 * holds a mutating capability (the builder), else `read-only` (planner / reviewer / verifier — they
 * still run commands, they just can't write files).
 */
export function capabilitiesToCodexSandbox(capabilities: readonly string[]): CodexSandboxPolicy {
  const canMutate = capabilities.some((c) => MUTATING_CAPABILITIES.has(c));
  return {
    sandbox: canMutate ? 'workspace-write' : 'read-only',
    webSearch: false,
  };
}
