import type { TaskPhase } from '@awb/domain';
import type { AgentRuntime } from './runtime-profile.js';

/**
 * Cheap vs strong. A phase's tier reflects how much reasoning it demands, NOT which vendor runs it:
 * heavy phases (deep planning, code synthesis, adversarial review) get the strong model; light phases
 * (scaffolding a contract, mechanical checks, wrap-up) get the cheap one. This lets a runtime default
 * to a phase-appropriate model when no project model is configured, so a full lifecycle doesn't pay
 * frontier-model rates for the light phases.
 */
export type PhaseModelTier = 'light' | 'heavy';

/** A runtime's default routing table: which tier a phase falls in, and the model name per tier. */
export interface PhaseModelRouting {
  tierForPhase: (phase: TaskPhase) => PhaseModelTier;
  modelForTier: Record<PhaseModelTier, string>;
}

/**
 * The runtime-agnostic phase→tier classification. Heavy phases carry the reasoning/synthesis load
 * (`plan`, `program-design`, `implement`, `challenge`); everything else is a lighter mechanical or
 * summary phase. One table for every runtime — only the concrete model NAMES differ per runtime.
 */
const HEAVY_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'plan',
  'program-design',
  'implement',
  'challenge',
]);

function tierForPhase(phase: TaskPhase): PhaseModelTier {
  return HEAVY_PHASES.has(phase) ? 'heavy' : 'light';
}

/**
 * Per-runtime tier→model names, in each runtime's own naming. `mock`/`pi` are absent: `mock` has no
 * real models, and `pi` owns its own local-model routing table (see pi-adapter). The three frontier
 * CLI runtimes (`claude`, `codex`, `opencode`) share this default routing when no project model is set.
 */
const RUNTIME_TIER_MODELS: Partial<Record<AgentRuntime, Record<PhaseModelTier, string>>> = {
  claude: { light: 'claude-haiku-4-5', heavy: 'claude-sonnet-4-5' },
  codex: { light: 'gpt-5.2-codex-mini', heavy: 'gpt-5.2-codex' },
  opencode: { light: 'anthropic/claude-haiku-4-5', heavy: 'anthropic/claude-sonnet-4-5' },
};

/** The default phase-routing table for a runtime, or `undefined` for runtimes that don't route by phase. */
export function defaultPhaseModelRouting(runtime: AgentRuntime): PhaseModelRouting | undefined {
  const modelForTier = RUNTIME_TIER_MODELS[runtime];
  if (!modelForTier) return undefined;
  return { tierForPhase, modelForTier };
}

/**
 * The shared helper the frontier profiles consult from `modelForPhase`: return the phase-appropriate
 * default model when the project hasn't pinned one. A project-configured `config.model` always wins
 * (operator override); otherwise route by the phase's tier. Runtimes without a routing table (or an
 * unknown phase) fall back to `config.model` (i.e. `undefined` here → the adapter's own default).
 */
export function defaultModelForPhase(
  runtime: AgentRuntime,
  phase: TaskPhase,
  config: { model?: string },
): string | undefined {
  if (config.model) return config.model;
  const routing = defaultPhaseModelRouting(runtime);
  if (!routing) return undefined;
  return routing.modelForTier[routing.tierForPhase(phase)];
}
