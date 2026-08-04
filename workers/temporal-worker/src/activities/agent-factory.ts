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

export function createAgentAdapter(
  runtime: AgentRuntime = resolveAgentRuntime(),
  config: RuntimeConfig = {},
): CodingAgentAdapter {
  return runtimeProfile(runtime).createAdapter(config);
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
