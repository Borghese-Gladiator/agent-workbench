/**
 * Runtime-neutral, per-stage tool policy.
 *
 * A stage's policy is expressed in CAPABILITIES — what the agent is allowed to
 * DO (read the code, edit files, run a shell, research the ticket, ask the
 * operator, dispatch subagents) — NOT in any one runtime's tool names. Each
 * adapter translates the capability set into its own tool vocabulary and
 * permission model via a per-runtime mapper (`mapPolicyToClaude`,
 * `mapPolicyToPi`). This keeps the safety boundary defined once, in terms the
 * lifecycle cares about, and lets a new runtime plug in by adding a mapper.
 *
 * The capability boundary is a HARD boundary, not a hint: a stage without the
 * `edit` capability has the runtime's file-mutation tools hard-denied (Claude
 * `--disallowed-tools`; Pi `--exclude-tools`), and a read-only stage runs in the
 * runtime's narrate-before-acting mode (Claude `--permission-mode plan`).
 */

/** What an agent is allowed to DO in a stage. Runtime-neutral. */
export type Capability =
  /** Read/search the codebase (cat/grep/glob equivalents). */
  | 'read'
  /** Mutate source files in place (edit existing files). */
  | 'edit'
  /** Run shell commands (tests, git, harness). */
  | 'shell'
  /** Write NEW files outside the source tree (e.g. a QA spec into a scratch dir). */
  | 'write'
  /** External research: web + issue-tracker/error-monitor MCP (the ticket/errors). */
  | 'research'
  /** Raise a deliberate question to the operator mid-run. */
  | 'ask'
  /** Dispatch work to subagents (the review/QA skills fan out via subagents). */
  | 'subagent';

/**
 * How file mutation is governed for the stage:
 * - `plan` — read-only stage; the runtime narrates intent and refuses mutations.
 * - `auto-edit` — edits auto-apply without prompting (the implementation agent).
 * - `gated` — edits are attempted but each routes to a permission prompt.
 */
export type MutationMode = 'plan' | 'auto-edit' | 'gated';

/**
 * A stage's capability policy. `escapeDeny` hard-denies the orchestration/escape
 * tools a read-only stage must never reach (observed shell-escape via subagent/
 * monitor tools); it is independent of the capability list so a stage can have,
 * say, `read` without inheriting `subagent`.
 */
export interface StageToolPolicy {
  capabilities: Capability[];
  /** Hard-deny the escape/orchestration tool family (read-only stages). */
  escapeDeny: boolean;
  mutationMode: MutationMode;
}

const has = (p: StageToolPolicy, c: Capability) => p.capabilities.includes(c);

/**
 * Per-stage capability policy. Covers every lifecycle stage an agent might run
 * in (keyed by `Stage`), not just the mock-runnable ones, so `implementation`,
 * `delivery_prep`, and `delivery_conflict` have policies too.
 *
 * Semantics preserved from the original Claude-named table:
 * - `task_brief`: EXTERNAL research only — NO code reading (the brief restates
 *   the request + linked ticket; exploring source is Discovery's job).
 * - `discovery`: read/search the code + research the ticket, no mutation, may ask.
 * - `implementation` / `delivery_conflict`: read/edit/shell, auto-applying edits.
 * - `feature_e2e`: read + shell + subagent + write the scratch QA spec, but
 *   NEVER edit the target's source (`write` without `edit`).
 * - `agent_self_review` / `delivery_prep`: read + shell, no mutation.
 * - `project_memory_summary`: pure text distillation — no tools.
 */
export const STAGE_TOOL_POLICY: Record<string, StageToolPolicy> = {
  task_brief: {
    capabilities: ['research'],
    escapeDeny: true,
    mutationMode: 'plan',
  },
  discovery: {
    capabilities: ['read', 'research', 'ask'],
    escapeDeny: true,
    mutationMode: 'plan',
  },
  implementation: {
    capabilities: ['read', 'edit', 'shell'],
    escapeDeny: false,
    mutationMode: 'auto-edit',
  },
  delivery_conflict: {
    capabilities: ['read', 'edit', 'shell'],
    escapeDeny: false,
    mutationMode: 'auto-edit',
  },
  feature_e2e: {
    capabilities: ['read', 'shell', 'write', 'subagent'],
    escapeDeny: false,
    mutationMode: 'gated',
  },
  agent_self_review: {
    capabilities: ['read', 'shell', 'subagent'],
    escapeDeny: false,
    mutationMode: 'gated',
  },
  delivery_prep: {
    capabilities: ['read', 'shell'],
    escapeDeny: false,
    mutationMode: 'gated',
  },
  project_memory_summary: {
    capabilities: [],
    escapeDeny: true,
    mutationMode: 'gated',
  },
};

/** Fallback policy for stages without an explicit entry: read/search only. */
export const DEFAULT_TOOL_POLICY: StageToolPolicy = {
  capabilities: ['read'],
  escapeDeny: true,
  mutationMode: 'plan',
};

export function policyForStage(stage: string): StageToolPolicy {
  return STAGE_TOOL_POLICY[stage] ?? DEFAULT_TOOL_POLICY;
}

/* ------------------------------------------------------------------ *
 *  Claude mapping — reproduces the original Claude-named tool lists.  *
 * ------------------------------------------------------------------ */

/** Codebase-reading tools (cat/grep/glob). */
const CLAUDE_CODE_READ = ['Read', 'Grep', 'Glob'];
/** File-mutation tools (no Bash) — denied when a stage lacks the `edit` capability. */
const CLAUDE_FILE_MUTATION = ['Edit', 'Write', 'NotebookEdit'];
/**
 * External-context tools the Task Brief MAY use to load the originating
 * ticket/issue: web fetch/search plus the Linear, Sentry, and Atlassian MCP
 * tools. The `mcp__` entries are name PREFIXES.
 */
const CLAUDE_RESEARCH = [
  'WebFetch',
  'WebSearch',
  'mcp__linear-server',
  'mcp__sentry',
  'mcp__atlassian',
];
/** Read-only Klaviyo issue-tracker / error-monitoring MCP tool prefixes. */
const CLAUDE_KLAVIYO_CONTEXT = ['mcp__linear-server', 'mcp__sentry'];
/**
 * Orchestration/escape tools a read-only stage must ALSO hard-deny. Observed in
 * a live discovery run: the agent probed `Agent`/`Task` fan-out, `ToolSearch`,
 * `Skill`, `ExitPlanMode`, and used `Monitor` as a shell escape (its command
 * field runs arbitrary shell, bypassing the `Bash` denial).
 */
const CLAUDE_ESCAPE = [
  'Task',
  'Agent',
  'Skill',
  'Monitor',
  'ToolSearch',
  'ExitPlanMode',
  'KillShell',
];

/**
 * The MCP tool the agent calls to ask the operator a deliberate question. It is
 * auto-approved (on `--allowed-tools`) for ask-enabled stages so that *calling
 * it* does not itself trip the permission gate — the question it raises is the
 * gate. Its name is fixed by the `--mcp-config` server name + tool name.
 */
export const ASK_TOOL = 'mcp__ask__workbench_ask';

/** Claude CLI permission mode for a stage's mutation mode. */
function claudePermissionMode(mode: MutationMode): 'plan' | 'default' | 'acceptEdits' {
  if (mode === 'plan') return 'plan';
  if (mode === 'auto-edit') return 'acceptEdits';
  return 'default';
}

/** The Claude-named tool lists + permission mode a stage's policy resolves to. */
export interface ClaudeToolPolicy {
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: 'plan' | 'default' | 'acceptEdits';
}

/**
 * Translate a capability policy into the Claude CLI's tool vocabulary. This
 * reproduces the original hand-written `STAGE_TOOL_POLICY` byte-for-byte (see
 * policy.test.ts) — it is the behavior-preservation contract for the Claude
 * adapter.
 */
export function mapPolicyToClaude(policy: StageToolPolicy): ClaudeToolPolicy {
  const allowed: string[] = [];
  // The Task Brief gets research WITHOUT code reading — exploring source is
  // Discovery's job, so the read tools are not just absent but hard-denied below.
  if (has(policy, 'read')) allowed.push(...CLAUDE_CODE_READ);
  if (has(policy, 'edit')) allowed.push('Edit', 'Write');
  if (has(policy, 'shell')) allowed.push('Bash');
  // `write` without `edit` = author new files (the scratch QA spec). Edit stays
  // denied; only Write is granted.
  if (has(policy, 'write') && !has(policy, 'edit')) allowed.push('Write');
  if (has(policy, 'subagent')) allowed.push('Task');
  if (has(policy, 'ask')) allowed.push(ASK_TOOL);
  if (has(policy, 'research')) {
    // The brief uses the full external-research set; discovery re-admits only the
    // read-only Klaviyo context (Linear/Sentry) alongside its code reading.
    allowed.push(...(has(policy, 'read') ? CLAUDE_KLAVIYO_CONTEXT : CLAUDE_RESEARCH));
  }

  // Hard-deny is derived from ABSENT capabilities, in the original list order
  // (Bash, then file-mutation, then escape, then — for the no-read brief —
  // code-read). A stage lacking `shell` denies Bash; lacking `edit` denies the
  // file-mutation tools (keeping Write when the stage has the `write`
  // capability, e.g. verification authoring the scratch QA spec).
  const disallowed: string[] = [];
  if (!has(policy, 'shell')) disallowed.push('Bash');
  if (!has(policy, 'edit')) {
    disallowed.push(
      ...CLAUDE_FILE_MUTATION.filter((t) => !(t === 'Write' && has(policy, 'write'))),
    );
  }
  if (policy.escapeDeny) disallowed.push(...CLAUDE_ESCAPE);
  // The brief restates the request + ticket but must NOT explore source: code
  // reading is hard-denied (appended after the mutation/escape deny list).
  if (policy.mutationMode === 'plan' && !has(policy, 'read')) disallowed.push(...CLAUDE_CODE_READ);

  // De-dupe + keep insertion order.
  return {
    allowedTools: [...new Set(allowed)],
    disallowedTools: [...new Set(disallowed)],
    permissionMode: claudePermissionMode(policy.mutationMode),
  };
}

/* ------------------------------------------------------------------ *
 *  Pi mapping — Pi Coding Agent's built-in tool surface.             *
 * ------------------------------------------------------------------ */

/** Pi's built-in tool names (see pi `--tools` / `--exclude-tools`). */
const PI_READ = ['read', 'grep', 'find', 'ls'];
const PI_EDIT = ['edit', 'write'];
const PI_WRITE = ['write'];
const PI_SHELL = ['bash'];
/** Every built-in Pi tool — used to compute the hard-deny (exclude) complement. */
const PI_ALL = [...new Set([...PI_READ, ...PI_EDIT, ...PI_SHELL])];

/** The Pi-named tool lists a stage's policy resolves to. */
export interface PiToolPolicy {
  /** `--tools` allowlist (the ONLY built-in tools the run may use). */
  tools: string[];
  /** `--exclude-tools` hard-deny list (the complement, for explicitness). */
  excludeTools: string[];
}

/**
 * Translate a capability policy into Pi's tool vocabulary. Pi has no
 * permission-mode concept (the `--mode json` path is non-interactive), so the
 * capability boundary is enforced purely structurally via `--tools`: a tool not
 * granted simply isn't available. Pi's surface has no Task/Monitor/Skill escape
 * tools, so `escapeDeny` needs no Pi-side expression — it is satisfied by the
 * allowlist being closed.
 */
export function mapPolicyToPi(policy: StageToolPolicy): PiToolPolicy {
  const tools: string[] = [];
  if (has(policy, 'read')) tools.push(...PI_READ);
  if (has(policy, 'edit')) tools.push(...PI_EDIT);
  if (has(policy, 'write') && !has(policy, 'edit')) tools.push(...PI_WRITE);
  if (has(policy, 'shell')) tools.push(...PI_SHELL);
  // `research`, `ask`, and `subagent` have no built-in Pi equivalent on the
  // `--mode json` path (no web/MCP tool surface, no permission-prompt relay),
  // so they map to nothing — documented gap, see pi.ts.
  const allow = [...new Set(tools)];
  return {
    tools: allow,
    excludeTools: PI_ALL.filter((t) => !allow.includes(t)),
  };
}

/* ------------------------------------------------------------------ *
 *  Codex mapping — sandbox modes, not per-tool lists.                 *
 * ------------------------------------------------------------------ */

/** The Codex CLI enforcement a stage's policy resolves to. */
export interface CodexToolPolicy {
  /**
   * `--sandbox` mode. Codex has NO per-tool allow/exclude vocabulary; its
   * boundary is the OS sandbox. `read-only` still lets commands RUN (so a
   * review stage can `git diff`) but blocks all filesystem writes.
   */
  sandbox: 'read-only' | 'workspace-write';
  /** Enable Codex's built-in web search tool (`research` capability). */
  webSearch: boolean;
}

/**
 * Translate a capability policy into Codex's sandbox vocabulary. This mapping
 * is deliberately COARSER than Claude/Pi's: any mutating capability (`edit` or
 * `write`) requires `workspace-write`, which cannot express feature_e2e's
 * "write scratch files but never edit source" split — documented softening.
 * `escapeDeny` is satisfied structurally (codex exec has no subagent/
 * orchestration tools), and `shell` cannot be denied independently — a
 * no-shell stage still relies on the read-only sandbox + prompt boundary.
 */
export function mapPolicyToCodex(policy: StageToolPolicy): CodexToolPolicy {
  return {
    sandbox: has(policy, 'edit') || has(policy, 'write') ? 'workspace-write' : 'read-only',
    webSearch: has(policy, 'research'),
  };
}
