import type { TaskPhase } from '@awb/domain';
import type { CodingAgentAdapter } from './adapter.js';
import { MockAgentAdapter } from './mock-adapter.js';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { PiAgentAdapter, piModelForPhase, PI_DEFAULT_MODEL } from './pi-adapter.js';
import { OpenCodeAgentAdapter } from './opencode-adapter.js';

/**
 * How much external-tool documentation a runtime's models can digest. Frontier hosted models
 * (`full`) get a tool's complete agent doc; runtimes serving small local models (`recipes`) get only
 * the terse per-stage recipe cards — the integration stays usable by ANY model, never gated off (the
 * standing "external tools must be model-agnostic" learning).
 */
export type ToolDocTier = 'full' | 'recipes';

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
   * only acceptable cwd; a missing worktree is a loud failure, never a `process.cwd()` fallback).
   * `mock` does not; every real runtime does.
   */
  readonly usesRealWorktree: boolean;

  /**
   * Whether phase run-state persists to the durable SQLite store so a worker restart mid-task resumes
   * with real state. Off for `mock` (its in-memory store keeps deterministic tests
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

  /**
   * How much external-tool documentation this runtime's models can digest ({@link ToolDocTier}).
   * `full` for frontier hosted models (Claude/Codex/hosted-OpenCode), `recipes` for runtimes serving
   * small local models (Pi/Ollama). Consumed by the tool-doc assembly so a run hands its models the
   * right depth of guidance; never used to gate a tool off entirely.
   */
  readonly toolDocTier: ToolDocTier;

  /**
   * Whether the workbench must independently verify that the candidate diff actually addresses each
   * behavioral claim, rather than trusting the agent to self-verify. TRUE for runtimes commonly
   * serving small/local models (`pi`, `opencode` with an ollama model), which produced the empty /
   * off-target candidates TASK-63 caught. FALSE for frontier hosted runtimes (`claude`, `codex`),
   * whose models are trusted to hit the target and for which the planner's `likelyPaths` prediction
   * adds no signal — gating on it there only risks false-blocking correct work whose files the
   * planner mis-predicted. (Honest imperfection: `opencode` can also run a hosted model; this flag
   * reflects the common local-model configuration and could later be refined per-project.)
   */
  readonly needsStringentCandidateChecks: boolean;

  /**
   * The model to run a given phase under, in THIS runtime's own naming, or `undefined` for the
   * runtime/adapter default. A project-configured `config.model` overrides the per-phase table for
   * every phase (operator override). Claude/Codex/OpenCode use one model for all phases today (return
   * `config.model`); Pi routes heavy reasoning phases to a fast model that doesn't stall locally.
   */
  modelForPhase(phase: TaskPhase, config: RuntimeConfig): string | undefined;

  /**
   * Build this runtime's adapter, injecting the project's {@link RuntimeConfig}. `phase` lets a
   * profile pick a phase-appropriate model via {@link modelForPhase}; omit it for a runtime-default
   * adapter (the mock/test path).
   */
  createAdapter(config: RuntimeConfig, phase?: TaskPhase): CodingAgentAdapter;
}

const mockProfile: RuntimeProfile = {
  runtime: 'mock',
  usesRealAgent: false,
  usesRealWorktree: false,
  usesDurableRunState: false,
  usesSdkToolNames: false,
  toolDocTier: 'recipes',
  needsStringentCandidateChecks: false,
  modelForPhase: () => undefined,
  createAdapter: () => new MockAgentAdapter(),
};

const claudeProfile: RuntimeProfile = {
  runtime: 'claude',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: true,
  toolDocTier: 'full',
  needsStringentCandidateChecks: false,
  modelForPhase: (_phase, config) => config.model,
  createAdapter: () => new ClaudeAgentAdapter(),
};

const codexProfile: RuntimeProfile = {
  runtime: 'codex',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  toolDocTier: 'full',
  needsStringentCandidateChecks: false,
  modelForPhase: (_phase, config) => config.model,
  createAdapter: (config) => new CodexAgentAdapter({ model: config.model, bin: config.binary }),
};

const piProfile: RuntimeProfile = {
  runtime: 'pi',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  // Local models digest terse recipe cards, not a tool's full agent doc.
  toolDocTier: 'recipes',
  // Local models can't be trusted to self-verify; the workbench checks the diff hits each claim.
  needsStringentCandidateChecks: true,
  // An explicit project model wins for every phase; otherwise the per-phase table routes heavy
  // reasoning phases to a fast model that doesn't stall locally, falling back to the capable default.
  modelForPhase: (phase, config) => config.model ?? piModelForPhase(phase),
  createAdapter: (config, phase) =>
    new PiAgentAdapter({
      model: config.model ?? (phase ? piModelForPhase(phase) : PI_DEFAULT_MODEL),
      bin: config.binary,
    }),
};

const openCodeProfile: RuntimeProfile = {
  runtime: 'opencode',
  usesRealAgent: true,
  usesRealWorktree: true,
  usesDurableRunState: true,
  usesSdkToolNames: false,
  // Hosted-capable, so full tool docs; but commonly driven with a local ollama model in practice.
  toolDocTier: 'full',
  needsStringentCandidateChecks: true,
  modelForPhase: (_phase, config) => config.model,
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
