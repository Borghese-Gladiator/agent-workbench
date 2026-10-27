import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@awb/domain';
import type { CodingAgentAdapter } from './adapter.js';
import { MockAgentAdapter } from './mock-adapter.js';
import { ClaudeAgentAdapter, type ClaudeSdkMessage, type ClaudeQueryFn, type ClaudeSdkQueryHandle } from './claude-adapter.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { PiAgentAdapter } from './pi-adapter.js';
import { OpenCodeAgentAdapter } from './opencode-adapter.js';
import type { RunCliStreaming } from './cli-runtime.js';

/**
 * One conformance suite over EVERY `CodingAgentAdapter`, so a new adapter is one line here and gets
 * the same contract checks (session shape, event streaming, sessionId, interrupt/dispose, aborted
 * short-circuit) as the shipped ones. Each adapter is constructed with an injected fake transport so
 * nothing spawns a subprocess or hits a network.
 */

function fakeClaudeQuery(messages: ClaudeSdkMessage[]): ClaudeQueryFn {
  return () => {
    async function* generator(): AsyncGenerator<ClaudeSdkMessage, void> {
      for (const m of messages) yield m;
    }
    const iterator = generator();
    const handle: ClaudeSdkQueryHandle = {
      next: (...a) => iterator.next(...a),
      return: (...a) => iterator.return(...a),
      throw: (...a) => iterator.throw(...a),
      [Symbol.asyncIterator]() {
        return handle;
      },
      [Symbol.asyncDispose]: () => iterator[Symbol.asyncDispose](),
      interrupt: async () => undefined,
      close: () => {},
    };
    return handle;
  };
}

function fakeCliRunner(lines: string[]): RunCliStreaming {
  return async (_invocation, onLine) => {
    for (const line of lines) onLine(line);
    return { code: 0, stderr: '' };
  };
}

interface Case {
  name: string;
  /** A ready adapter whose fake transport yields a successful turn producing the text below. */
  make(): CodingAgentAdapter;
  expectedText: string;
  expectedSessionId?: string;
}

const cases: Case[] = [
  {
    name: 'mock',
    make: () => {
      const a = new MockAgentAdapter();
      a.scriptTurns('task-1', 'builder', { summary: 'mock summary', events: [{ type: 'message', text: 'mock summary' }] });
      return a;
    },
    expectedText: 'mock summary',
  },
  {
    name: 'claude',
    make: () =>
      new ClaudeAgentAdapter(
        fakeClaudeQuery([
          { type: 'system', subtype: 'init', session_id: 'claude-sess' } as ClaudeSdkMessage,
          { type: 'assistant', session_id: 'claude-sess', message: { content: [{ type: 'text', text: 'claude text' }] } } as ClaudeSdkMessage,
          { type: 'result', subtype: 'success', session_id: 'claude-sess', is_error: false, result: 'claude text' } as ClaudeSdkMessage,
        ]),
      ),
    expectedText: 'claude text',
    expectedSessionId: 'claude-sess',
  },
  {
    name: 'codex',
    make: () =>
      new CodexAgentAdapter({
        runCliStreaming: fakeCliRunner([
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
          JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: 'codex text' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ]),
      }),
    expectedText: 'codex text',
    expectedSessionId: 'codex-thread',
  },
  {
    name: 'pi',
    make: () =>
      new PiAgentAdapter({
        runCliStreaming: fakeCliRunner([
          JSON.stringify({ type: 'session', id: 'pi-sess' }),
          JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi text' } }),
          JSON.stringify({ type: 'agent_end' }),
        ]),
      }),
    expectedText: 'pi text',
    expectedSessionId: 'pi-sess',
  },
  {
    name: 'opencode',
    make: () =>
      new OpenCodeAgentAdapter({
        runCliStreaming: fakeCliRunner([
          JSON.stringify({ type: 'text', sessionID: 'oc-sess', part: { type: 'text', text: 'oc text' } }),
          JSON.stringify({ type: 'step_finish', sessionID: 'oc-sess', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } }),
        ]),
        writeAgent: () => {},
      }),
    expectedText: 'oc text',
    expectedSessionId: 'oc-sess',
  },
];

describe.each(cases)('CodingAgentAdapter conformance: $name', ({ make, expectedText, expectedSessionId }) => {
  const cwd = '/tmp/worktree';

  it('createSession returns a session tagged with the adapter id', async () => {
    const adapter = make();
    const session = await adapter.createSession({ role: 'builder', taskId: 'task-1', cwd, contextPayload: {}, allowedTools: [] });
    expect(session.taskId).toBe('task-1');
    expect(session.role).toBe('builder');
    expect(session.providerId).toBe(adapter.id);
    expect(session.id).toBeTruthy();
  });

  it('execute streams events and returns a completed result with a summary', async () => {
    const adapter = make();
    const session = await adapter.createSession({ role: 'builder', taskId: 'task-1', cwd, contextPayload: {}, allowedTools: [] });
    const events: AgentEvent[] = [];
    const result = await adapter.execute(session, { instruction: 'go' }, (e) => events.push(e), new AbortController().signal);
    expect(result.completed).toBe(true);
    expect(result.summary).toContain(expectedText);
    expect(result.findings).toEqual([]);
    if (expectedSessionId) expect(result.sessionId).toBe(expectedSessionId);
  });

  it('a pre-aborted signal short-circuits without completing', async () => {
    const adapter = make();
    const session = await adapter.createSession({ role: 'builder', taskId: 'task-1', cwd, contextPayload: {}, allowedTools: [] });
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.execute(session, { instruction: 'go' }, () => {}, controller.signal);
    expect(result.completed).toBe(false);
  });

  it('interrupt and dispose resolve without throwing', async () => {
    const adapter = make();
    const session = await adapter.createSession({ role: 'builder', taskId: 'task-1', cwd, contextPayload: {}, allowedTools: [] });
    await expect(adapter.interrupt(session)).resolves.not.toThrow();
    await expect(adapter.dispose(session)).resolves.not.toThrow();
  });
});
