/**
 * RuntimeProfile — the single source of truth for how one agent harness behaves.
 *
 * Before this, "what does runtime X need / support / speak" was scattered across
 * the daemon as `=== 'claude'` / `!== 'mock'` branches plus Claude-vocabulary
 * tables (model aliases, the `--effort` scale). A profile collects all of that
 * per-runtime knowledge in one place, so the daemon asks the profile instead of
 * branching on a runtime string. Adding a harness = adding a profile; the daemon
 * never learns its name.
 *
 * This generalizes the pattern the capability policy already uses (neutral
 * capabilities + per-runtime tool mappers) to the other concerns that differ by
 * runtime: which adapter, which model per stage, how hard it thinks, whether it
 * supports a mid-run permission gate, and whether it needs a real git worktree.
 */

import type { AgentRuntime, RuntimeConfig } from '@workbench/core';
import { ClaudeAgentRuntimeAdapter } from './claude.js';
import { CodexAgentRuntimeAdapter } from './codex.js';
import { Effort } from './effort.js';
import { type AgentRuntimeAdapter, MockAgentRuntimeAdapter } from './index.js';
import { PiAgentRuntimeAdapter } from './pi.js';
import type { ToolDocTier } from './skills.js';

/**
 * Everything the daemon needs to know about a runtime without naming it. A
 * profile is pure policy/config — it never touches disk, git, or SQLite.
 */
export interface RuntimeProfile {
  readonly runtime: AgentRuntime;

  /**
   * Build the adapter for a project, injecting its {@link RuntimeConfig} (model,
   * binary, …). Called once per run by the daemon's adapter factory.
   */
  createAdapter(config: RuntimeConfig): AgentRuntimeAdapter;

  /**
   * The model a stage runs under, in THIS runtime's own naming, or `undefined`
   * to use the runtime's default. The Claude profile keeps its per-stage alias
   * table; the Pi profile uses the project's configured `provider/id` for every
   * stage (Ollama/etc. have one local model, not a per-stage menu).
   */
  modelForStage(stage: string, config: RuntimeConfig): string | undefined;

  /** How hard the stage should think, or `undefined` for the runtime default. */
  effortForStage(stage: string): Effort | undefined;

  /**
   * Whether this runtime can pause MID-STAGE for a tool-permission prompt relayed
   * to the operator. This is NOT the lifecycle's human approval gates (those are
   * runtime-agnostic and always apply) — it is the finer-grained per-tool-call
   * prompt. Claude supports it via an MCP relay; Pi's `--mode json` does not, so
   * Pi enforces its capability boundary structurally and runs each stage to
   * completion without mid-run prompts.
   */
  readonly supportsMidRunGate: boolean;

  /**
   * Whether the runtime operates in a real git worktree/checkout. `mock` does
   * not (it returns canned content against a placeholder repo); every real
   * runtime does.
   */
  readonly usesRealWorktree: boolean;

  /**
   * How much external-tool documentation this runtime's models can digest (see
   * {@link ToolDocTier}). Claude gets a tool's full agent doc; runtimes serving
   * small local models get only the per-stage recipe cards — the integration
   * stays usable by ANY model, never gated off.
   */
  readonly toolDocTier: ToolDocTier;

  /**
   * Declares the per-project config fields this runtime surfaces in the UI, so
   * the create-project form is driven by the profile rather than hardcoding which
   * runtime shows which inputs. Empty for runtimes that take no config (`mock`).
   */
  readonly configFields: readonly RuntimeConfigField[];
}

/** A single configurable {@link RuntimeConfig} field, for the create-project form. */
export interface RuntimeConfigField {
  key: keyof RuntimeConfig;
  label: string;
  placeholder?: string;
  required?: boolean;
}

/* ------------------------------------------------------------------ *
 *  Claude                                                            *
 * ------------------------------------------------------------------ */

/**
 * Per-stage model aliases for Claude. The expensive reasoning stages (`discovery`,
 * `implementation`) are LEFT OUT so they keep the adapter default (Opus); bounded
 * stages pick a model sized to the work, paired with {@link CLAUDE_STAGE_EFFORT}.
 */
const CLAUDE_STAGE_MODEL: Record<string, string> = {
  task_brief: 'opus',
  feature_e2e: 'haiku',
  agent_self_review: 'opus',
  delivery_prep: 'opus',
  project_memory_summary: 'opus',
};

/** Per-stage `--effort`. A stage's model says WHICH model; this says HOW HARD it thinks. */
const CLAUDE_STAGE_EFFORT: Record<string, Effort> = {
  task_brief: Effort.Low,
  agent_self_review: Effort.High,
  delivery_prep: Effort.Low,
  project_memory_summary: Effort.High,
};

const claudeProfile: RuntimeProfile = {
  runtime: 'claude',
  createAdapter: (config) =>
    new ClaudeAgentRuntimeAdapter({
      // A configured model becomes the adapter default; per-stage overrides from
      // modelForStage still win at call time.
      model: config.model,
    }),
  // A project-configured model overrides the per-stage alias for every stage;
  // otherwise use the per-stage table (undefined -> adapter default).
  modelForStage: (stage, config) => config.model ?? CLAUDE_STAGE_MODEL[stage],
  effortForStage: (stage) => CLAUDE_STAGE_EFFORT[stage],
  supportsMidRunGate: true,
  usesRealWorktree: true,
  toolDocTier: 'full',
  configFields: [
    {
      key: 'model',
      label: 'Model (optional)',
      placeholder: 'opus (default) / sonnet / haiku',
    },
  ],
};

/* ------------------------------------------------------------------ *
 *  Pi                                                                *
 * ------------------------------------------------------------------ */

/**
 * The Ollama model the Pi runtime falls back to when a project doesn't configure
 * one. `qwen3-coder:30b` is the capable code model used for the reasoning + build
 * stages (brief / discovery / implementation / delivery_prep).
 */
const PI_DEFAULT_MODEL = 'ollama/qwen3-coder:30b';

/**
 * Per-stage Pi model defaults, validated by a full live delivery run on
 * 2026-06-30. Unlike Claude (one provider, many sized models), Ollama serves one
 * model at a time, but the heavy REVIEW stages behave differently from the build
 * stages on the same hardware:
 *
 *  - `feature_e2e` + `agent_self_review`: qwen3-coder:30b reliably STALLED here
 *    (went silent past the 10-min watchdog and was killed) — these stages are
 *    long-context, low-tool reasoning that the 30B coder model chokes on locally.
 *    `llama3.2:latest` (fast 3B) completes them quickly, so they default to it.
 *  - every other stage: the capable {@link PI_DEFAULT_MODEL}.
 *
 * A project-configured `runtimeConfig.model` OVERRIDES this table for ALL stages
 * (see `modelForStage`), so operators can still pin a single model on purpose.
 */
const PI_STAGE_MODEL: Record<string, string> = {
  feature_e2e: 'ollama/llama3.2:latest',
  agent_self_review: 'ollama/llama3.2:latest',
};

const piProfile: RuntimeProfile = {
  runtime: 'pi',
  createAdapter: (config) =>
    new PiAgentRuntimeAdapter({ model: config.model ?? PI_DEFAULT_MODEL, bin: config.binary }),
  // An explicit project model wins for EVERY stage (operator override). Absent
  // that, use the per-stage default table — falling back to the capable default
  // for stages not in it. This is why a fresh Pi project "just works" with the
  // models the live run proved, without per-project config.
  modelForStage: (stage, config) => config.model ?? PI_STAGE_MODEL[stage] ?? PI_DEFAULT_MODEL,
  // Pi's `--thinking` maps from the same neutral Effort, but the workbench keeps
  // no per-stage thinking table for Pi (local models gain little from it); the
  // adapter passes whatever effort a run carries. Default: none.
  effortForStage: () => undefined,
  supportsMidRunGate: false,
  usesRealWorktree: true,
  // Local models are reliable at copying a recipe card's literal commands, not at
  // synthesizing invocations from a long doc.
  toolDocTier: 'recipes',
  configFields: [
    {
      key: 'model',
      label: 'Model (optional — overrides per-stage defaults)',
      placeholder: PI_DEFAULT_MODEL,
    },
    {
      key: 'binary',
      label: 'pi binary (optional)',
      placeholder: 'pi',
    },
  ],
};

/* ------------------------------------------------------------------ *
 *  Codex                                                             *
 * ------------------------------------------------------------------ */

const codexProfile: RuntimeProfile = {
  runtime: 'codex',
  createAdapter: (config) =>
    new CodexAgentRuntimeAdapter({ model: config.model, bin: config.binary }),
  // One model for every stage: the project's configured model, else Codex's own
  // configured default (undefined -> no --model flag). No per-stage table yet —
  // add one once live runs show a stage that wants a differently-sized model.
  modelForStage: (_stage, config) => config.model,
  effortForStage: () => undefined,
  // `codex exec` is non-interactive: no permission-prompt relay mid-run.
  supportsMidRunGate: false,
  usesRealWorktree: true,
  // Frontier hosted models: full external-tool docs, like Claude.
  toolDocTier: 'full',
  configFields: [
    {
      key: 'model',
      label: 'Model (optional)',
      placeholder: 'gpt-5.2-codex (codex default)',
    },
    {
      key: 'binary',
      label: 'codex binary (optional)',
      placeholder: 'codex',
    },
  ],
};

/* ------------------------------------------------------------------ *
 *  Mock                                                              *
 * ------------------------------------------------------------------ */

const mockProfile: RuntimeProfile = {
  runtime: 'mock',
  createAdapter: () => new MockAgentRuntimeAdapter(),
  modelForStage: () => undefined,
  effortForStage: () => undefined,
  supportsMidRunGate: false,
  usesRealWorktree: false,
  toolDocTier: 'recipes',
  configFields: [],
};

/* ------------------------------------------------------------------ *
 *  Registry                                                          *
 * ------------------------------------------------------------------ */

const PROFILES: Record<AgentRuntime, RuntimeProfile> = {
  mock: mockProfile,
  claude: claudeProfile,
  pi: piProfile,
  codex: codexProfile,
};

/** The profile for a runtime. The daemon's one entry point for runtime behavior. */
export function runtimeProfile(runtime: AgentRuntime): RuntimeProfile {
  return PROFILES[runtime];
}
