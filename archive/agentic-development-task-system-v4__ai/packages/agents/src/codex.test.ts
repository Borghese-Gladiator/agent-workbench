import { describe, expect, it } from 'vitest';
import { CodexAgentRuntimeAdapter, consumeCodexStreamLine, newCodexAccumulator } from './codex.js';
import type { AgentRunInput, StreamEvent, StreamHandlers } from './index.js';
import { bufferingHandlers, Effort } from './index.js';
import type { CliInvocation, CliStreamResult } from './run-shared.js';

const codexInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  taskId: 'task_1',
  stage: 'discovery',
  worktreePath: '/tmp/wt/task_1',
  contextArtifactIds: ['art_a'],
  allowedTools: [],
  taskTitle: 'Add dark mode',
  rawRequest: 'Users want a dark mode toggle.',
  ...over,
});

/** A streaming runner that replays scripted JSONL lines, then closes with `code`. */
function fakeStream(lines: string[], code = 0, capture?: { inv?: CliInvocation }) {
  return async (
    inv: CliInvocation,
    onLine: (line: string) => void | Promise<void>,
  ): Promise<CliStreamResult> => {
    if (capture) capture.inv = inv;
    for (const line of lines) await onLine(line);
    return { code, stderr: '' };
  };
}

function collecting(): { events: StreamEvent[]; handlers: StreamHandlers } {
  const events: StreamEvent[] = [];
  return {
    events,
    handlers: { onEvent: (e) => events.push(e), requestInput: bufferingHandlers().requestInput },
  };
}

// --- Codex JSONL line builders (shapes verified live on codex-cli 0.142.5) ---
const threadStarted = (id: string) => JSON.stringify({ type: 'thread.started', thread_id: id });
const turnStarted = () => JSON.stringify({ type: 'turn.started' });
const agentMessage = (text: string) =>
  JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
const commandStart = (command: string) =>
  JSON.stringify({
    type: 'item.started',
    item: { id: 'item_2', type: 'command_execution', command, status: 'in_progress' },
  });
const commandEnd = (command: string, exitCode: number, output: string) =>
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command,
      exit_code: exitCode,
      aggregated_output: output,
      status: exitCode === 0 ? 'completed' : 'failed',
    },
  });
const errorItem = (message: string) =>
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'error', message } });
// Usage is snake_case with `cached_input_tokens` (NOT cache_read_input_tokens).
const turnCompleted = (usage?: Record<string, number>) =>
  JSON.stringify({ type: 'turn.completed', usage });
const turnFailed = (message: string) =>
  JSON.stringify({ type: 'turn.failed', error: { message } });

/** A minimal successful Codex run: one turn that emits a substantive body. */
const successLines = (body: string, id = 'thread-1') => [
  threadStarted(id),
  turnStarted(),
  agentMessage(body),
  turnCompleted({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 50 }),
];

const valuesAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

/** All `-c key=value` config overrides in the invocation. */
const configOverrides = (args: string[]): string[] =>
  args.flatMap((a, i) => (a === '-c' ? [args[i + 1]!] : []));

describe('CodexAgentRuntimeAdapter.streamStageAgent (injected JSONL stream)', () => {
  it('refuses to run without a worktree', async () => {
    const adapter = new CodexAgentRuntimeAdapter({ runCliStreaming: fakeStream([], 0) });
    const res = await adapter.streamStageAgent(
      codexInput({ worktreePath: undefined }),
      collecting().handlers,
    );
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/worktree/);
  });

  it('runs `exec --json` confined to the worktree cwd, git-check skipped, project docs off', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('A real discovery plan body.'), 0, capture),
    });
    await adapter.streamStageAgent(codexInput(), collecting().handlers);

    const inv = capture.inv!;
    expect(inv.cwd).toBe('/tmp/wt/task_1');
    expect(inv.args.slice(0, 2)).toEqual(['exec', '--json']);
    // Worktrees under the daemon data dir are not codex-trusted directories.
    expect(inv.args).toContain('--skip-git-repo-check');
    // AGENTS.md discovery off — the daemon inlines exactly the context it wants.
    expect(configOverrides(inv.args)).toContain('project_doc_max_bytes=0');
  });

  it('maps the discovery policy to a read-only sandbox with web search', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('plan body here, substantial.'), 0, capture),
    });
    await adapter.streamStageAgent(codexInput({ stage: 'discovery' }), collecting().handlers);

    expect(valuesAfter(capture.inv!.args, '--sandbox')).toBe('read-only');
    expect(configOverrides(capture.inv!.args)).toContain('tools.web_search=true');
  });

  it('maps the implementation policy to workspace-write without web search', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('done'), 0, capture),
    });
    await adapter.streamStageAgent(codexInput({ stage: 'implementation' }), collecting().handlers);

    expect(valuesAfter(capture.inv!.args, '--sandbox')).toBe('workspace-write');
    expect(configOverrides(capture.inv!.args)).not.toContain('tools.web_search=true');
  });

  it('passes the model and maps effort -> model_reasoning_effort (max clamps to xhigh)', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('done'), 0, capture),
    });
    await adapter.streamStageAgent(
      codexInput({ stage: 'implementation', model: 'gpt-5.2-codex', effort: Effort.Max }),
      collecting().handlers,
    );
    expect(valuesAfter(capture.inv!.args, '--model')).toBe('gpt-5.2-codex');
    expect(configOverrides(capture.inv!.args)).toContain('model_reasoning_effort="xhigh"');
  });

  it('prepends the stage system prompt to the packet on fresh runs', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('plan body, long enough to pass.'), 0, capture),
    });
    await adapter.streamStageAgent(codexInput(), collecting().handlers);

    const prompt = capture.inv!.args[capture.inv!.args.length - 1]!;
    expect(prompt).toMatch(/^You are a stage-specific coding agent/);
    expect(prompt).toContain('# Stage: discovery');
  });

  it('resume runs `exec ... resume <threadId>` with ONLY the comment, no stage packet', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(
        successLines('redone plan body, substantial enough.'),
        0,
        capture,
      ),
    });
    await adapter.streamStageAgent(
      codexInput({ resume: { sessionId: 'thread-prev', message: 'Please address X.' } }),
      collecting().handlers,
    );
    const args = capture.inv!.args;
    expect(valuesAfter(args, 'resume')).toBe('thread-prev');
    expect(args[args.length - 1]).toBe('Please address X.');
    expect(args[args.length - 1]).not.toContain('# Stage:');
  });

  it('produces the stage artifact + sessionId (thread id) on success', async () => {
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(
        successLines('A substantive execution plan body for discovery.', 'thread-xyz'),
      ),
    });
    const res = await adapter.streamStageAgent(
      codexInput({ stage: 'discovery' }),
      collecting().handlers,
    );
    expect(res.status).toBe('succeeded');
    expect(res.sessionId).toBe('thread-xyz');
    expect(res.produced).toHaveLength(1);
    expect(res.produced[0]!.kind).toBe('execution_plan');
    expect(res.produced[0]!.body).toContain('execution plan body');
  });

  it('a non-fatal error item (e.g. config deprecation) does NOT fail the run', async () => {
    // Observed live on 0.142.5: a user-config deprecation streams as an error
    // item on a run that still succeeds with exit 0.
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream([
        threadStarted('t1'),
        errorItem('`[features].codex_hooks` is deprecated.'),
        turnStarted(),
        agentMessage('A substantive plan body regardless of the notice.'),
        turnCompleted({ input_tokens: 10, output_tokens: 5 }),
      ]),
    });
    const res = await adapter.streamStageAgent(codexInput(), collecting().handlers);
    expect(res.status).toBe('succeeded');
  });

  it('fails on turn.failed with the error message', async () => {
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream([
        threadStarted('t1'),
        turnStarted(),
        agentMessage('partial output before the failure'),
        turnFailed('model quota exceeded'),
      ]),
    });
    const res = await adapter.streamStageAgent(codexInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/model quota exceeded/);
    expect(res.sessionId).toBe('t1');
  });

  it('fails on a non-zero exit code', async () => {
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('partial'), 1),
    });
    const res = await adapter.streamStageAgent(codexInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/exit 1/);
  });

  it('fails on empty output', async () => {
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: fakeStream([threadStarted('t'), turnStarted(), turnCompleted()], 0),
    });
    const res = await adapter.streamStageAgent(codexInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/empty output/);
  });

  it('surfaces a spawn failure as failed (e.g. codex not installed)', async () => {
    const adapter = new CodexAgentRuntimeAdapter({
      runCliStreaming: async () => {
        throw new Error('spawn codex ENOENT');
      },
    });
    const res = await adapter.streamStageAgent(codexInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/failed to run codex CLI/);
  });
});

describe('consumeCodexStreamLine', () => {
  const fixedNow = () => 1000;

  it('captures the session id from thread.started', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(threadStarted('thread-7'), acc, handlers, fixedNow);
    expect(acc.sessionId).toBe('thread-7');
    expect(events).toHaveLength(0);
  });

  it('emits a turn event with an index on turn.started', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(turnStarted(), acc, handlers, fixedNow);
    expect(events).toEqual([{ type: 'turn', payload: { index: 1, ttftMs: null } }]);
    expect(acc.turns).toBe(1);
  });

  it('joins agent_message items into finalText and emits assistant_text', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(agentMessage('First part.'), acc, handlers, fixedNow);
    consumeCodexStreamLine(agentMessage('Second part.'), acc, handlers, fixedNow);
    expect(acc.finalText).toBe('First part.\n\nSecond part.');
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'First part.' } },
      { type: 'assistant_text', payload: { text: 'Second part.' } },
    ]);
  });

  it('maps command_execution start/completion to tool_call/tool_result', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(commandStart('ls'), acc, handlers, fixedNow);
    consumeCodexStreamLine(commandEnd('ls', 0, 'file.txt'), acc, handlers, fixedNow);
    expect(events[0]).toEqual({
      type: 'tool_call',
      payload: { name: 'shell', input: { command: 'ls' } },
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
      payload: { status: 'ok', summary: 'file.txt' },
    });
  });

  it('marks a failed command as status error', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(commandEnd('false', 1, 'boom'), acc, handlers, fixedNow);
    expect(events[0]).toEqual({
      type: 'tool_result',
      payload: { status: 'error', summary: 'boom' },
    });
  });

  it('aggregates per-turn usage, mapping cached_input_tokens to cacheRead', () => {
    const acc = newCodexAccumulator();
    const { handlers } = collecting();
    consumeCodexStreamLine(
      turnCompleted({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 }),
      acc,
      handlers,
      fixedNow,
    );
    consumeCodexStreamLine(
      turnCompleted({ input_tokens: 60, cached_input_tokens: 10, output_tokens: 5 }),
      acc,
      handlers,
      fixedNow,
    );
    expect(acc.usage).toMatchObject({
      inputTokens: 160,
      outputTokens: 25,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: null,
    });
  });

  it('records turn.failed as the fatal error', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(turnFailed('rate limited'), acc, handlers, fixedNow);
    expect(acc.errorMessage).toBe('rate limited');
    expect(events[0]).toEqual({ type: 'error', payload: { message: 'rate limited' } });
  });

  it('surfaces an error ITEM as an event without setting the fatal error', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine(errorItem('deprecated config'), acc, handlers, fixedNow);
    expect(acc.errorMessage).toBeUndefined();
    expect(events[0]).toEqual({ type: 'error', payload: { message: 'deprecated config' } });
  });

  it('ignores non-JSON noise and unknown item types', () => {
    const acc = newCodexAccumulator();
    const { events, handlers } = collecting();
    consumeCodexStreamLine('not json', acc, handlers, fixedNow);
    consumeCodexStreamLine(
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } }),
      acc,
      handlers,
      fixedNow,
    );
    expect(events).toHaveLength(0);
    expect(acc.finalText).toBe('');
  });
});
