import { MockAgentAdapter, ClaudeAgentAdapter, type CodingAgentAdapter, type MockTurnScript } from '@awb/agent-gateway';

export type AgentRuntime = 'mock' | 'claude';

/**
 * Which agent backend the Activities use, from `AWB_AGENT_RUNTIME`. Read only inside Activities
 * (never in Workflow code — the determinism boundary). Defaults to `mock` so every deterministic
 * test keeps its scripted, offline behavior (docs/decisions/005).
 */
export function resolveAgentRuntime(): AgentRuntime {
  return process.env.AWB_AGENT_RUNTIME === 'claude' ? 'claude' : 'mock';
}

export function createAgentAdapter(runtime: AgentRuntime = resolveAgentRuntime()): CodingAgentAdapter {
  return runtime === 'claude' ? new ClaudeAgentAdapter() : new MockAgentAdapter();
}

function isMockAdapter(adapter: CodingAgentAdapter): adapter is MockAgentAdapter {
  return adapter instanceof MockAgentAdapter;
}

/**
 * Scripts a mock turn only when the adapter is the mock — a no-op against the real Claude adapter,
 * so phase code can keep its scripted-turn setup without branching on the runtime everywhere.
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
