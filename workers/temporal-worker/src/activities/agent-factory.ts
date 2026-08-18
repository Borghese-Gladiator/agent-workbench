import type { TaskPhase } from '@awb/domain';
import {
  MockAgentAdapter,
  isAgentRuntime,
  runtimeProfile,
  type AgentRuntime,
  type CodingAgentAdapter,
  type MockTurnScript,
  type RuntimeConfig,
  type RuntimeProfile,
} from '@awb/agent-gateway';

export type { AgentRuntime, RuntimeProfile } from '@awb/agent-gateway';

/**
 * Which agent backend the Activities use, from `AWB_AGENT_RUNTIME`. Read only inside Activities
 * (never in Workflow code — the determinism boundary). Defaults to `mock` so every deterministic
 * test keeps its scripted, offline behavior (docs/decisions/005); an unrecognized value also maps to
 * `mock` rather than throwing, so a typo degrades safely to the offline path.
 */
export function resolveAgentRuntime(): AgentRuntime {
  const value = process.env.AWB_AGENT_RUNTIME;
  return value && isAgentRuntime(value) ? value : 'mock';
}

/** The RuntimeProfile for the selected runtime — the one entry point for real-vs-mock phase behavior. */
export function resolveRuntimeProfile(runtime: AgentRuntime = resolveAgentRuntime()): RuntimeProfile {
  return runtimeProfile(runtime);
}

/**
 * The runtime config assembled from the environment. Per-project config isn't persisted yet (runtime
 * is global via `AWB_AGENT_RUNTIME`), so the model/binary come from env vars: `AWB_AGENT_MODEL`
 * (a runtime-native model id, e.g. `ollama/qwen3-coder:30b` for opencode), `AWB_AGENT_BINARY`, and
 * `AWB_AGENT_PROVIDER_BASE_URL` (a credential-free self-hosted/proxy endpoint the CLI runtimes that
 * honor it target; the Claude SDK reads `ANTHROPIC_BASE_URL` directly and ignores this). Unset →
 * empty config → the profile/adapter default. This is the seam per-project config slots into.
 */
export function resolveRuntimeConfig(): RuntimeConfig {
  const config: RuntimeConfig = {};
  const model = process.env.AWB_AGENT_MODEL;
  const binary = process.env.AWB_AGENT_BINARY;
  const providerBaseUrl = process.env.AWB_AGENT_PROVIDER_BASE_URL;
  if (model) config.model = model;
  if (binary) config.binary = binary;
  if (providerBaseUrl) config.providerBaseUrl = providerBaseUrl;
  return config;
}

/**
 * Build the adapter for the selected runtime. `phase` lets a profile pick a phase-appropriate model
 * (Pi routes the heavy `challenge` review phase to a fast local model); omit it for the runtime
 * default. `config` defaults to {@link resolveRuntimeConfig} (env-sourced model/binary).
 */
export function createAgentAdapter(
  runtime: AgentRuntime = resolveAgentRuntime(),
  config: RuntimeConfig = resolveRuntimeConfig(),
  phase?: TaskPhase,
): CodingAgentAdapter {
  return runtimeProfile(runtime).createAdapter(config, phase);
}

function isMockAdapter(adapter: CodingAgentAdapter): adapter is MockAgentAdapter {
  return adapter instanceof MockAgentAdapter;
}

/**
 * Scripts a mock turn only when the adapter is the mock — a no-op against any real adapter, so phase
 * code can keep its scripted-turn setup without branching on the runtime everywhere.
 */
export function scriptMockTurns(
  adapter: CodingAgentAdapter,
  taskId: string,
  role: string,
  ...turns: MockTurnScript[]
): void {
  if (isMockAdapter(adapter)) {
    adapter.scriptTurns(taskId, role, ...turns);
  }
}
