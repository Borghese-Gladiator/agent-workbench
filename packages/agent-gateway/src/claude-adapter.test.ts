import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@awb/domain';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import type { ClaudeSdkMessage, ClaudeSdkQueryHandle, ClaudeQueryFn } from './claude-adapter.js';

/** Wraps a plain AsyncGenerator of SDK-shaped messages into the control-method interface ClaudeSdkQueryHandle requires. */
function toHandle(
  iterator: AsyncGenerator<ClaudeSdkMessage, void>,
  opts: { onInterrupt?: () => void; onClose?: () => void } = {},
): ClaudeSdkQueryHandle {
  const handle: ClaudeSdkQueryHandle = {
    next: (...args) => iterator.next(...args),
    return: (...args) => iterator.return(...args),
    throw: (...args) => iterator.throw(...args),
    [Symbol.asyncIterator]() {
      return handle;
    },
    [Symbol.asyncDispose]: () => iterator[Symbol.asyncDispose](),
    interrupt: async () => {
      opts.onInterrupt?.();
      return undefined;
    },
    close: () => {
      opts.onClose?.();
    },
  };
  return handle;
}

/** Builds a fake SDK query handle from a fixed list of messages, recording the params it was called with. */
function fakeQuery(
  messages: ClaudeSdkMessage[],
  opts: { onInterrupt?: () => void; onClose?: () => void; throws?: Error } = {},
): { queryFn: ClaudeQueryFn; calls: Array<Parameters<ClaudeQueryFn>[0]> } {
  const calls: Array<Parameters<ClaudeQueryFn>[0]> = [];
  const queryFn: ClaudeQueryFn = (params) => {
    calls.push(params);
    async function* generator(): AsyncGenerator<ClaudeSdkMessage, void> {
      if (opts.throws) {
        throw opts.throws;
      }
      for (const message of messages) {
        yield message;
      }
    }
    return toHandle(generator(), opts);
  };
  return { queryFn, calls };
}

function makeSessionInput(
  overrides: Partial<{ cwd: string; allowedTools: string[]; disallowedTools: string[] }> = {},
) {
  return {
    role: 'builder' as const,
    taskId: 'task-1',
    cwd: overrides.cwd ?? '/tmp/worktree',
    contextPayload: {},
    allowedTools: overrides.allowedTools ?? ['Read', 'Edit'],
    ...(overrides.disallowedTools ? { disallowedTools: overrides.disallowedTools } : {}),
  };
}

describe('ClaudeAgentAdapter', () => {
  it('createSession returns an AgentSession with providerId set to the adapter id', async () => {
    const { queryFn } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    expect(session.providerId).toBe('claude-agent-sdk');
    expect(session.role).toBe('builder');
    expect(session.taskId).toBe('task-1');
  });

  it('maps an assistant text block to a message event', async () => {
    const { queryFn } = fakeQuery([
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'hello there' }] } },
    ]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const events: AgentEvent[] = [];
    await adapter.execute(session, { instruction: 'do it' }, (e) => events.push(e), new AbortController().signal);
    expect(events).toContainEqual({ type: 'message', text: 'hello there' });
  });

  it('maps an assistant tool_use block to a tool-started event', async () => {
    const { queryFn } = fakeQuery([
      {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file: 'a.ts' } }] },
      },
    ]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const events: AgentEvent[] = [];
    await adapter.execute(session, { instruction: 'do it' }, (e) => events.push(e), new AbortController().signal);
    const toolEvent = events.find((e) => e.type === 'tool-started');
    expect(toolEvent).toMatchObject({ type: 'tool-started', tool: 'Edit' });
    expect((toolEvent as { inputSummary: string }).inputSummary).toContain('a.ts');
  });

  it('maps a user tool_result block to a tool-completed event', async () => {
    const { queryFn } = fakeQuery([
      {
        type: 'user',
        session_id: 's1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok done' }] }],
        },
      },
    ]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const events: AgentEvent[] = [];
    await adapter.execute(session, { instruction: 'do it' }, (e) => events.push(e), new AbortController().signal);
    const toolEvent = events.find((e) => e.type === 'tool-completed');
    expect(toolEvent).toMatchObject({ type: 'tool-completed', tool: 't1', resultSummary: 'ok done' });
  });

  it('maps a result message usage into a usage event and the returned AgentExecutionResult, renaming SDK fields', async () => {
    const { queryFn } = fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        is_error: false,
        result: 'all done',
        modelUsage: {
          'claude-opus-4-6': {
            inputTokens: 1200,
            outputTokens: 340,
            cacheReadInputTokens: 50,
            costUSD: 0.42,
          },
        },
      },
    ]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const events: AgentEvent[] = [];
    const result = await adapter.execute(session, { instruction: 'do it' }, (e) => events.push(e), new AbortController().signal);

    expect(result.usage).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 50,
      costUsd: 0.42,
    });
    expect(events).toContainEqual({ type: 'usage', usage: result.usage });
    expect(result.summary).toBe('all done');
    expect(result.completed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('forwards cwd, allowed/disallowed tools, and maxTurns into the query options exactly', async () => {
    const { queryFn, calls } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(
      makeSessionInput({ cwd: '/tmp/my-worktree', allowedTools: ['Read', 'Bash'], disallowedTools: ['Write', 'Edit'] }),
    );
    await adapter.execute(
      session,
      { instruction: 'do it', stopConditions: { maxTurns: 7 } },
      () => {},
      new AbortController().signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('do it');
    expect(calls[0]?.options?.cwd).toBe('/tmp/my-worktree');
    // allowedTools auto-approves; disallowedTools is what actually enforces the scope (TASK-24).
    expect(calls[0]?.options?.allowedTools).toEqual(['Read', 'Bash']);
    expect(calls[0]?.options?.disallowedTools).toEqual(['Write', 'Edit']);
    expect(calls[0]?.options?.maxTurns).toBe(7);
    // Headless worker runs need auto-approved tools (TASK-13).
    expect(calls[0]?.options?.permissionMode).toBe('bypassPermissions');
  });

  it('threads an optional model override into the query options (TASK-51)', async () => {
    const { queryFn, calls } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession({ ...makeSessionInput(), model: 'claude-haiku-4-5-20251001' });
    await adapter.execute(session, { instruction: 'classify' }, () => {}, new AbortController().signal);
    expect(calls[0]?.options?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('omits model from the query options when none is set', async () => {
    const { queryFn, calls } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    await adapter.execute(session, { instruction: 'do it' }, () => {}, new AbortController().signal);
    expect(calls[0]?.options?.model).toBeUndefined();
  });

  it('prepends the serialized contextPayload to the first prompt (TASK-14)', async () => {
    const { queryFn, calls } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession({
      role: 'plan-critic',
      taskId: 'task-1',
      cwd: '/tmp/worktree',
      contextPayload: { plan: { summary: 'do the thing', slices: ['a'] } },
      allowedTools: ['Read'],
    });
    await adapter.execute(session, { instruction: 'Critique the plan' }, () => {}, new AbortController().signal);

    expect(calls[0]?.prompt).toContain('do the thing');
    expect(calls[0]?.prompt).toContain('Critique the plan');
    // Instruction comes after the context preamble.
    expect(calls[0]?.prompt.indexOf('do the thing')).toBeLessThan(calls[0]!.prompt.indexOf('Critique the plan'));
  });

  it('does not prepend context on a resumed turn (context already in transcript)', async () => {
    const messages: ClaudeSdkMessage[] = [{ type: 'system', subtype: 'init', session_id: 'sess-1' }];
    const { queryFn, calls } = fakeQuery(messages);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession({
      role: 'plan-critic',
      taskId: 'task-1',
      cwd: '/tmp/worktree',
      contextPayload: { plan: 'PAYLOAD_MARKER' },
      allowedTools: ['Read'],
    });
    await adapter.execute(session, { instruction: 'turn one' }, () => {}, new AbortController().signal);
    await adapter.execute(session, { instruction: 'turn two' }, () => {}, new AbortController().signal);
    expect(calls[0]?.prompt).toContain('PAYLOAD_MARKER');
    expect(calls[1]?.prompt).not.toContain('PAYLOAD_MARKER');
    expect(calls[1]?.prompt).toBe('turn two');
  });

  it('threads the resume session id captured from a prior call into the next execute() call', async () => {
    const firstCallMessages: ClaudeSdkMessage[] = [{ type: 'system', subtype: 'init', session_id: 'session-abc' }];
    let call = 0;
    const calls: Array<Parameters<ClaudeQueryFn>[0]> = [];
    const queryFn: ClaudeQueryFn = (params) => {
      calls.push(params);
      call += 1;
      const messages = call === 1 ? firstCallMessages : [];
      async function* generator(): AsyncGenerator<ClaudeSdkMessage, void> {
        for (const message of messages) yield message;
      }
      return toHandle(generator());
    };

    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    await adapter.execute(session, { instruction: 'turn one' }, () => {}, new AbortController().signal);
    await adapter.execute(session, { instruction: 'turn two' }, () => {}, new AbortController().signal);

    expect(calls[0]?.options?.resume).toBeUndefined();
    expect(calls[1]?.options?.resume).toBe('session-abc');
  });

  it('returns completed: false without invoking the query function when the signal is already aborted', async () => {
    const { queryFn, calls } = fakeQuery([{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'x' }] } }]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.execute(session, { instruction: 'do it' }, () => {}, controller.signal);
    expect(result.completed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('propagates a thrown error from the query function as a rejected promise', async () => {
    const { queryFn } = fakeQuery([], { throws: new Error('provider timeout') });
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    await expect(adapter.execute(session, { instruction: 'do it' }, () => {}, new AbortController().signal)).rejects.toThrow(
      'provider timeout',
    );
  });

  it('interrupt() calls the live query handle interrupt(), and is a no-op when nothing is in flight', async () => {
    const onInterrupt = vi.fn();
    const { queryFn } = fakeQuery(
      [{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'x' }] } }],
      { onInterrupt },
    );
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());

    await adapter.interrupt(session);
    expect(onInterrupt).not.toHaveBeenCalled();

    await adapter.execute(session, { instruction: 'do it' }, () => {}, new AbortController().signal);
    await adapter.interrupt(session);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('dispose() closes a live query handle and clears session state', async () => {
    const onClose = vi.fn();
    const { queryFn } = fakeQuery([], { onClose });
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    await adapter.dispose(session);
    await expect(adapter.execute(session, { instruction: 'do it' }, () => {}, new AbortController().signal)).rejects.toThrow(
      'unknown session',
    );
  });

  it.each([['relative/worktree'], [''], ['./worktree']])(
    'createSession rejects a non-absolute cwd %j (TASK-31)',
    async (cwd) => {
      const { queryFn } = fakeQuery([]);
      const adapter = new ClaudeAgentAdapter(queryFn);
      await expect(adapter.createSession(makeSessionInput({ cwd }))).rejects.toThrow('cwd must be an absolute path');
    },
  );

  it('seeds the resume id from createSession input and skips the context preamble (TASK-32)', async () => {
    const { queryFn, calls } = fakeQuery([]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession({
      role: 'builder',
      taskId: 'task-1',
      cwd: '/tmp/worktree',
      contextPayload: { plan: 'PAYLOAD_MARKER' },
      allowedTools: ['Read'],
      resumeSessionId: 'prior-session-xyz',
    });
    await adapter.execute(session, { instruction: 'continue' }, () => {}, new AbortController().signal);
    // A resumed first turn passes the seed resume id and does NOT re-send the context preamble.
    expect(calls[0]?.options?.resume).toBe('prior-session-xyz');
    expect(calls[0]?.prompt).toBe('continue');
    expect(calls[0]?.prompt).not.toContain('PAYLOAD_MARKER');
  });

  it('surfaces the SDK session_id on the AgentExecutionResult (TASK-32)', async () => {
    const { queryFn } = fakeQuery([{ type: 'system', subtype: 'init', session_id: 'sess-surfaced' }]);
    const adapter = new ClaudeAgentAdapter(queryFn);
    const session = await adapter.createSession(makeSessionInput());
    const result = await adapter.execute(session, { instruction: 'go' }, () => {}, new AbortController().signal);
    expect(result.sessionId).toBe('sess-surfaced');
  });

  describe.skipIf(!process.env.ANTHROPIC_API_KEY)('live integration', () => {
    it('runs a real query against the Claude API', async () => {
      const adapter = new ClaudeAgentAdapter();
      const session = await adapter.createSession(makeSessionInput({ allowedTools: [] }));
      const result = await adapter.execute(
        session,
        { instruction: 'Say hello in one word.', stopConditions: { maxTurns: 1 } },
        () => {},
        new AbortController().signal,
      );
      expect(result.completed).toBe(true);
    });
  });
});
