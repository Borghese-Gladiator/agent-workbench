import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelUsage } from '@awb/domain';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from './adapter.js';

/**
 * A narrow slice of the real SDK's text/tool_use content blocks — the only assistant-message
 * shapes this adapter translates into AgentEvents. Kept intentionally minimal (rather than
 * importing the full `@anthropic-ai/sdk` BetaContentBlock union) so this file's typing surface
 * only covers what it actually consumes.
 */
export interface ClaudeSdkTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeSdkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ClaudeSdkToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export type ClaudeSdkContentBlock = ClaudeSdkTextBlock | ClaudeSdkToolUseBlock | ClaudeSdkToolResultBlock | { type: string };

/** Per-model usage row as reported by the SDK's `result` message (`SDKResultMessage.modelUsage`). */
export interface ClaudeSdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/** The subset of `SDKSystemMessage` (subtype 'init') this adapter reads. */
export interface ClaudeSdkSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
}

/** The subset of `SDKAssistantMessage` this adapter reads. */
export interface ClaudeSdkAssistantMessage {
  type: 'assistant';
  session_id: string;
  message: {
    content: ClaudeSdkContentBlock[];
  };
}

/** The subset of `SDKUserMessage` this adapter reads (tool_result blocks reflected back to the agent). */
export interface ClaudeSdkUserMessage {
  type: 'user';
  session_id: string;
  message: {
    content: ClaudeSdkContentBlock[];
  };
}

/** The subset of `SDKResultMessage` this adapter reads (both the 'success' and 'error' subtypes carry these fields). */
export interface ClaudeSdkResultMessage {
  type: 'result';
  subtype: string;
  session_id: string;
  is_error: boolean;
  result?: string;
  modelUsage?: Record<string, ClaudeSdkModelUsage>;
}

export type ClaudeSdkMessage =
  | ClaudeSdkSystemInitMessage
  | ClaudeSdkAssistantMessage
  | ClaudeSdkUserMessage
  | ClaudeSdkResultMessage
  | { type: string; session_id?: string };

/** The live query handle returned by the SDK's `query()` — an async generator plus control methods. */
export interface ClaudeSdkQueryHandle extends AsyncGenerator<ClaudeSdkMessage, void> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface ClaudeSdkQueryOptions {
  cwd?: string;
  tools?: string[];
  maxTurns?: number;
  resume?: string;
  abortController?: AbortController;
}

/**
 * Injectable seam over the SDK's `query()` function, mirroring the `CommandExecutor` pattern in
 * `packages/workspace/src/prepare-env.ts`: tests supply a fake that yields SDK-shaped messages
 * from a scripted async generator instead of spawning the real Claude Code subprocess.
 */
export type ClaudeQueryFn = (params: { prompt: string; options?: ClaudeSdkQueryOptions }) => ClaudeSdkQueryHandle;

/** Default query function: the real SDK. */
const realQuery: ClaudeQueryFn = (params) => query(params) as unknown as ClaudeSdkQueryHandle;

interface ClaudeSessionState {
  cwd: string;
  allowedTools: string[];
  resumeSessionId?: string;
  liveQuery?: ClaudeSdkQueryHandle;
}

function summarizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content.find((block): block is ClaudeSdkTextBlock => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    });
    if (first) return first.text;
  }
  return 'tool result';
}

function toDomainUsage(model: string, usage: ClaudeSdkModelUsage): ModelUsage {
  return {
    provider: 'anthropic',
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    costUsd: usage.costUSD,
  };
}

/** Picks a single primary usage row from the SDK's per-model breakdown (our ModelUsage is singular, not a map). */
function primaryUsage(modelUsage: Record<string, ClaudeSdkModelUsage> | undefined): ModelUsage | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  const first = entries[0];
  if (!first) return undefined;
  return toDomainUsage(first[0], first[1]);
}

/**
 * Real CodingAgentAdapter backed by `@anthropic-ai/claude-agent-sdk`'s `query()` streaming API
 * (product spec §19: use the SDK's structured event stream, not CLI text parsing).
 */
export class ClaudeAgentAdapter implements CodingAgentAdapter {
  readonly id = 'claude-agent-sdk';

  private readonly queryFn: ClaudeQueryFn;
  private readonly state = new Map<string, ClaudeSessionState>();

  constructor(queryFn: ClaudeQueryFn = realQuery) {
    this.queryFn = queryFn;
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      role: input.role,
      taskId: input.taskId,
      providerId: this.id,
      createdAt: new Date().toISOString(),
    };
    this.state.set(session.id, {
      cwd: input.cwd,
      allowedTools: input.allowedTools,
    });
    return session;
  }

  async execute(
    session: AgentSession,
    assignment: AgentAssignment,
    eventSink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const state = this.state.get(session.id);
    if (!state) {
      throw new Error(`ClaudeAgentAdapter: unknown session ${session.id}`);
    }

    if (signal.aborted) {
      return { completed: false, findings: [], summary: 'aborted before start' };
    }

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort);

    const handle = this.queryFn({
      prompt: assignment.instruction,
      options: {
        cwd: state.cwd,
        tools: state.allowedTools,
        maxTurns: assignment.stopConditions?.maxTurns,
        resume: state.resumeSessionId,
        abortController,
      },
    });
    state.liveQuery = handle;

    let usage: ModelUsage | undefined;
    let summary = '';
    let completed = true;

    try {
      for await (const message of handle) {
        if (signal.aborted) {
          completed = false;
          break;
        }

        switch (message.type) {
          case 'system': {
            const init = message as ClaudeSdkSystemInitMessage;
            if (init.subtype === 'init') {
              state.resumeSessionId = init.session_id;
            }
            break;
          }
          case 'assistant': {
            const assistantMessage = message as ClaudeSdkAssistantMessage;
            state.resumeSessionId = assistantMessage.session_id;
            for (const block of assistantMessage.message.content) {
              if (block.type === 'text') {
                const textBlock = block as ClaudeSdkTextBlock;
                eventSink({ type: 'message', text: textBlock.text });
              } else if (block.type === 'tool_use') {
                const toolUseBlock = block as ClaudeSdkToolUseBlock;
                eventSink({
                  type: 'tool-started',
                  tool: toolUseBlock.name,
                  inputSummary: JSON.stringify(toolUseBlock.input),
                });
              }
            }
            break;
          }
          case 'user': {
            const userMessage = message as ClaudeSdkUserMessage;
            state.resumeSessionId = userMessage.session_id;
            for (const block of userMessage.message.content) {
              if (block.type === 'tool_result') {
                const toolResultBlock = block as ClaudeSdkToolResultBlock;
                eventSink({
                  type: 'tool-completed',
                  tool: toolResultBlock.tool_use_id,
                  resultSummary: summarizeToolResultContent(toolResultBlock.content),
                });
              }
            }
            break;
          }
          case 'result': {
            const resultMessage = message as ClaudeSdkResultMessage;
            state.resumeSessionId = resultMessage.session_id;
            summary = resultMessage.result ?? (resultMessage.is_error ? 'execution ended with an error' : 'execution completed');
            usage = primaryUsage(resultMessage.modelUsage);
            if (usage) {
              eventSink({ type: 'usage', usage });
            }
            break;
          }
          default:
            break;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      state.liveQuery = undefined;
    }

    return {
      completed,
      findings: [],
      usage,
      summary: summary || (completed ? 'execution completed' : 'interrupted during execution'),
    };
  }

  async interrupt(session: AgentSession): Promise<void> {
    const state = this.state.get(session.id);
    if (!state?.liveQuery) return;
    await state.liveQuery.interrupt();
  }

  async dispose(session: AgentSession): Promise<void> {
    const state = this.state.get(session.id);
    if (state?.liveQuery) {
      state.liveQuery.close();
    }
    this.state.delete(session.id);
  }
}
