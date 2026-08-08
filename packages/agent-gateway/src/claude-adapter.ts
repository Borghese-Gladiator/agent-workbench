import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
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
  /**
   * Tools to auto-approve without a permission prompt (the SDK's `allowedTools`). This does NOT
   * restrict the session to only these — the SDK treats `allowedTools` as an auto-approve list, not
   * an allowlist. Restriction is done via `disallowedTools`.
   */
  allowedTools?: string[];
  /**
   * Tools to DENY (the SDK's `disallowedTools`). A bare tool name removes the tool from the session
   * entirely, in every permission mode INCLUDING `bypassPermissions` — this is what actually enforces
   * a read-only role's capability scope (TASK-24, §18/§33).
   */
  disallowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  /** Provider model to use for this query (TASK-51); when omitted the SDK uses its default model. */
  model?: string;
  abortController?: AbortController;
  /**
   * The SDK's permission mode. Workbench sessions run headless in a worker with no human to answer
   * interactive tool-permission prompts, so the default mode leaves every tool call denied ("Claude
   * requested permissions … but you haven't granted it yet") and the agent makes no edits. Sessions
   * operate inside a task-scoped worktree already gated by the capability broker + human repo-trust,
   * so `bypassPermissions` is the correct non-interactive mode here.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
}

/**
 * Injectable seam over the SDK's `query()` function, mirroring the `CommandExecutor` pattern in
 * `packages/workspace/src/prepare-env.ts`: tests supply a fake that yields SDK-shaped messages
 * from a scripted async generator instead of spawning the real Claude Code subprocess.
 */
export type ClaudeQueryFn = (params: { prompt: string; options?: ClaudeSdkQueryOptions }) => ClaudeSdkQueryHandle;

/** Default query function: the real SDK. */
const realQuery: ClaudeQueryFn = (params) => query(params) as unknown as ClaudeSdkQueryHandle;

/** Thrown by `completeOnce` when the completion did not produce usable text (SDK error, error result, or empty output). */
export class CompletionError extends Error {
  constructor(
    message: string,
    /** The SDK result `subtype` when one was seen (e.g. 'error_max_turns'), else undefined. */
    readonly subtype?: string,
  ) {
    super(message);
    this.name = 'CompletionError';
  }
}

/**
 * Single-turn text completion over the SDK — no tools, no session, just prompt → text. For synthesis
 * steps that are not the full agent loop (e.g. the repository-memory compile/lint passes, TASK-50).
 * The `queryFn` seam lets a test supply a scripted generator instead of spawning Claude Code.
 *
 * Fails LOUDLY (throws `CompletionError`) rather than returning '' so a caller can never mistake a
 * provider failure for "the model legitimately had nothing to say": the SDK signals failure via a
 * `result` message with `is_error: true` (e.g. `subtype: 'error_max_turns'`), and a stream that ends
 * with no `result` at all is also a failure. Only a clean, non-empty result is returned as text.
 */
export async function completeOnce(prompt: string, queryFn: ClaudeQueryFn = realQuery): Promise<string> {
  let result: ClaudeSdkResultMessage | undefined;
  try {
    const handle = queryFn({ prompt, options: { permissionMode: 'bypassPermissions', maxTurns: 1 } });
    for await (const message of handle) {
      if (message.type === 'result') {
        result = message as ClaudeSdkResultMessage;
      }
    }
  } catch (err) {
    // The SDK threw mid-stream (spawn failure, transport drop, abort). Surface it as a CompletionError.
    throw new CompletionError(`completion stream failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!result) {
    throw new CompletionError('completion produced no result message');
  }
  if (result.is_error) {
    throw new CompletionError(`completion ended with an error (${result.subtype})`, result.subtype);
  }
  const text = result.result ?? '';
  if (text.trim() === '') {
    throw new CompletionError('completion returned empty text', result.subtype);
  }
  return text;
}

interface ClaudeSessionState {
  cwd: string;
  allowedTools: string[];
  /** Tools denied for this session; enforced via the SDK's `disallowedTools` (TASK-24). */
  disallowedTools: string[];
  /** The caller's context payload (contract/plan/diff/evidence), serialized into the first prompt. */
  contextPayload: unknown;
  /** Optional provider model override for this session (TASK-51). */
  model?: string;
  resumeSessionId?: string;
  liveQuery?: ClaudeSdkQueryHandle;
}

/**
 * Serializes the session's contextPayload into a prompt preamble. The SDK only sends
 * `assignment.instruction` as the prompt, so without this a role whose instruction doesn't embed
 * its inputs (plan-critic, adversarial-reviewer) never sees the plan/diff/contract it is meant to
 * judge and returns nothing useful. Only prepended on the FIRST turn of a session (a resumed turn
 * already has the context in its transcript). Large payloads are truncated so a huge diff can't
 * blow the prompt.
 */
function contextPreamble(contextPayload: unknown): string {
  if (contextPayload === undefined || contextPayload === null) return '';
  let serialized: string;
  try {
    serialized = JSON.stringify(contextPayload, null, 2);
  } catch {
    return '';
  }
  if (!serialized || serialized === '{}' || serialized === 'null') return '';
  const MAX = 60_000;
  const body = serialized.length > MAX ? `${serialized.slice(0, MAX)}\n…[truncated ${serialized.length - MAX} chars]` : serialized;
  return `Context for this task (JSON):\n\`\`\`json\n${body}\n\`\`\`\n\n`;
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
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
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
    // The cwd MUST be absolute (TASK-31): a relative or empty cwd would resolve against the SDK
    // subprocess's own working directory (the worker/workbench repo), letting path-less agent
    // discovery drift out of the pinned task worktree. Fail loudly rather than silently drift.
    if (!input.cwd || !isAbsolute(input.cwd)) {
      throw new Error(`ClaudeAgentAdapter.createSession: cwd must be an absolute path, got ${JSON.stringify(input.cwd)}`);
    }
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
      disallowedTools: input.disallowedTools ?? [],
      contextPayload: input.contextPayload,
      model: input.model,
      // TASK-32: seed the resume token if the caller is resuming a prior (possibly cross-process)
      // session. When set, `execute` skips the context preamble and passes `resume` to the SDK.
      resumeSessionId: input.resumeSessionId,
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

    // First turn of the session (no resume id yet): prepend the serialized contextPayload so the
    // agent actually sees its inputs. Resumed turns already carry the context in the transcript.
    const prompt =
      state.resumeSessionId === undefined
        ? `${contextPreamble(state.contextPayload)}${assignment.instruction}`
        : assignment.instruction;

    const handle = this.queryFn({
      prompt,
      options: {
        cwd: state.cwd,
        // allowedTools auto-approves the granted tools (no prompt in the headless worker);
        // disallowedTools hard-removes everything else, enforced even under bypassPermissions —
        // this is what makes a read-only role provably unable to Write/Edit/Bash (TASK-24, §18/§33).
        allowedTools: state.allowedTools,
        disallowedTools: state.disallowedTools,
        maxTurns: assignment.stopConditions?.maxTurns,
        resume: state.resumeSessionId,
        model: state.model,
        abortController,
        // Headless worker: no human to answer per-tool permission prompts. See the option's doc.
        permissionMode: 'bypassPermissions',
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
      // Surface the SDK's resumable session_id (captured into state above) so callers can persist it
      // durably and resume this transcript on a later attempt (TASK-32).
      sessionId: state.resumeSessionId,
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
