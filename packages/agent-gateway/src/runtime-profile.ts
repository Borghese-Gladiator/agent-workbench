import type { CodingAgentAdapter } from './adapter.js';
import { MockAgentAdapter } from './mock-adapter.js';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { PiAgentAdapter } from './pi-adapter.js';
import { OpenCodeAgentAdapter } from './opencode-adapter.js';

export const AGENT_RUNTIMES = ['mock', 'claude', 'codex', 'pi', 'opencode'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(value: string): value is AgentRuntime {
  return (AGENT_RUNTIMES as readonly string[]).includes(value);
}

/**
 * Per-project runtime configuration threaded into the adapter at construction. Runtime-neutral (a
 * model id, a binary path) — never credentials. The active tree selects the runtime globally by
 * `AWB_AGENT_RUNTIME`, so callers pass an empty config today; the field exists so per-project config
 * can be layered later without changing the profile contract.
 */
export interface RuntimeConfig {
  /** Model id/pattern in this runtime's own naming (e.g. `sonnet`, `gpt-5.2-codex`). */
  model?: string;
  /** Path/name of the CLI binary, when the runtime shells out to one. */
  binary?: string;
}

/**
 * The single source of truth for how one runtime behaves. Replaces the scattered
 * `ctx.strategy === 'claude'` branches in the phase activity: "run the real path" becomes a property
 * of the selected runtime (`usesRealAgent`), not a string equality on one vendor's name. Adding a
 * runtime = adding a profile; the activity never learns its name.
 */
export interface RuntimeProfile {
  readonly runtime: AgentRuntime;

  /**
   * Whether this runtime drives a REAL coding agent (real contract from the prompt, real planner,
   * real builder edits, real QA, real delivery). Only `mock` is false — it returns scripted turns
   * and canned candidates against a placeholder repo, the one explicit fallback path.
   */
  readonly usesRealAgent: boolean;

  /**
   * Whether the runtime operates inside a real git worktree/checkout (the pinned task worktree is the
   * only acceptable cwd; a missing worktree is a loud failure, never a `process.cwd()` fallback —
   * TASK-31). `mock` does not; every real runtime does.
   */
  readonly usesRealWorktree: boolean;

  /**
   * Whether phase run-state persists to the durable SQLite store so a worker restart mid-task resumes
   * with real state (TASK-27). Off for `mock` (its in-memory store keeps deterministic tests
   * unchanged). Forced off globally by `AWB_DURABLE_RUN_STATE=0` at the call site.
   */
  readonly usesDurableRunState: boolean;

  /**
   * Whether the role's granted capabilities must be mapped to concrete Claude-SDK tool names
   * (Read/Write/Edit/Bash/…) before being handed to the session. TRUE only for the Claude SDK path:
   * the SDK's `tools` must be SDK tool names, not the abstract capability strings, or it recognizes
   * none of them. The CLI adapters take the capability strings (or map to their own `--tools` surface
   * internally), so this is genuinely Claude-adapter-specific.
   */
  readonly usesSdkToolNames: boolean;

  /** Build this runtime's adapter, injecting the project's {@link RuntimeConfig}. */
  createAdapter(config: RuntimeConfig): CodingAgentAdapter;
}

const mockProfile: RuntimeProfile = {
  runtime: 'mock',
  usesRealAgent: false,
  usesRealWorktree: false,
  usesDurableRunState: false,
  usesSdkToolNames: false,
  createAdapter: () => new MockAgentAdapter(),
};

const claudeProfile: RuntimeProfile = {
  runtime: 'claude',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: true,
  createAdapter: () => new ClaudeAgentAdapter(),
};

const codexProfile: RuntimeProfile = {
  runtime: 'codex',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  createAdapter: (config) => new CodexAgentAdapter({ model: config.model, bin: config.binary }),
};

const piProfile: RuntimeProfile = {
  runtime: 'pi',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  createAdapter: (config) => new PiAgentAdapter({ model: config.model, bin: config.binary }),
};

const openCodeProfile: RuntimeProfile = {
  runtime: 'opencode',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  createAdapter: (config) => new OpenCodeAgentAdapter({ model: config.model, bin: config.binary }),
};

const PROFILES: Record<AgentRuntime, RuntimeProfile> = {
  mock: mockProfile,
  claude: claudeProfile,
  codex: codexProfile,
  pi: piProfile,
  opencode: openCodeProfile,
};

/** The profile for a runtime — the one entry point for runtime behavior. */
export function runtimeProfile(runtime: AgentRuntime): RuntimeProfile {
  return PROFILES[runtime];
}
