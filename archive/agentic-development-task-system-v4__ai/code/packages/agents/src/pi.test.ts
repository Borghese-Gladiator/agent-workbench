import { describe, expect, it } from 'vitest';
import type { AgentRunInput, StreamEvent, StreamHandlers } from './index.js';
import { bufferingHandlers, Effort } from './index.js';
import { consumePiStreamLine, newPiAccumulator, PiAgentRuntimeAdapter } from './pi.js';
import type { CliInvocation, CliStreamResult } from './run-shared.js';

const piInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  taskId: 'task_1',
  stage: 'discovery',
  worktreePath: '/tmp/wt/task_1',
  contextArtifactIds: ['art_a'],
  allowedTools: [],
  taskTitle: 'Add dark mode',
  rawRequest: 'Users want a dark mode toggle.',
  ...over,
});

/** A streaming runner that replays scripted NDJSON lines, then closes with `code`. */
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

// --- Pi NDJSON line builders ---
const session = (id: string) => JSON.stringify({ type: 'session', version: 3, id });
const turnStart = () => JSON.stringify({ type: 'turn_start' });
const textDelta = (delta: string) =>
  JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
const toolStart = (toolName: string, args: unknown) =>
  JSON.stringify({ type: 'tool_execution_start', toolName, args });
const toolEnd = (toolName: string, result: unknown, isError = false) =>
  JSON.stringify({ type: 'tool_execution_end', toolName, result, isError });
// Pi's usage object is camelCase (input/output/cacheRead/cacheWrite), verified
// against pi 0.80.2 — NOT Anthropic snake_case.
const turnEnd = (usage?: Record<string, number>) =>
  JSON.stringify({ type: 'turn_end', message: usage ? { usage } : {} });
const agentEnd = () => JSON.stringify({ type: 'agent_end', messages: [] });

/** A minimal successful Pi run: one turn that emits a substantive plan body. */
const successLines = (body: string, id = 'sess-1') => [
  session(id),
  turnStart(),
  textDelta(body),
  turnEnd({ input: 100, output: 50 }),
  agentEnd(),
];

const valuesAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('PiAgentRuntimeAdapter.streamStageAgent (injected NDJSON stream)', () => {
  it('refuses to run without a worktree', async () => {
    const adapter = new PiAgentRuntimeAdapter({ runCliStreaming: fakeStream([], 0) });
    const { handlers } = collecting();
    const res = await adapter.streamStageAgent(piInput({ worktreePath: undefined }), handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/worktree/);
  });

  it('uses `--mode json`, confined to the worktree cwd, with context-files off', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('A real discovery plan body.'), 0, capture),
    });
    const { handlers } = collecting();

    await adapter.streamStageAgent(piInput(), handlers);

    const inv = capture.inv!;
    expect(inv.cwd).toBe('/tmp/wt/task_1');
    expect(inv.args).toEqual(expect.arrayContaining(['--mode', 'json']));
    expect(inv.args).toContain('--no-context-files');
    expect(inv.args).toContain('-p');
    // `pi` has no turn-cap flag — it rejects `--max-turns` as an unknown option
    // (verified against pi 0.80.2). Never emit it.
    expect(inv.args).not.toContain('--max-turns');
  });

  it('maps the discovery policy to Pi read-only tools (no edit/bash)', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('plan body here, substantial.'), 0, capture),
    });
    await adapter.streamStageAgent(piInput({ stage: 'discovery' }), collecting().handlers);

    const tools = valuesAfter(capture.inv!.args, '--tools') ?? '';
    expect(tools.split(',')).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']));
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('bash');
    const excluded = valuesAfter(capture.inv!.args, '--exclude-tools') ?? '';
    expect(excluded.split(',')).toEqual(expect.arrayContaining(['edit', 'write', 'bash']));
  });

  it('maps the implementation policy to read/edit/write/bash', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('done'), 0, capture),
    });
    await adapter.streamStageAgent(piInput({ stage: 'implementation' }), collecting().handlers);

    const tools = (valuesAfter(capture.inv!.args, '--tools') ?? '').split(',');
    expect(tools).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'bash']));
  });

  it('passes the model and maps effort -> --thinking (max clamps to xhigh)', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('done'), 0, capture),
    });
    await adapter.streamStageAgent(
      piInput({ stage: 'implementation', model: 'claude-opus-4-5', effort: Effort.Max }),
      collecting().handlers,
    );
    expect(valuesAfter(capture.inv!.args, '--model')).toBe('claude-opus-4-5');
    expect(valuesAfter(capture.inv!.args, '--thinking')).toBe('xhigh');
  });

  it('resume sends ONLY the comment with --session, no stage packet', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(
        successLines('redone plan body, substantial enough.'),
        0,
        capture,
      ),
    });
    await adapter.streamStageAgent(
      piInput({ resume: { sessionId: 'sess-prev', message: 'Please address X.' } }),
      collecting().handlers,
    );
    const args = capture.inv!.args;
    expect(valuesAfter(args, '--session')).toBe('sess-prev');
    // The prompt after -p is the bare comment, not a stage packet.
    expect(valuesAfter(args, '-p')).toBe('Please address X.');
  });

  it('runs ungated: never wires an MCP permission-prompt tool', async () => {
    const capture: { inv?: CliInvocation } = {};
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('done'), 0, capture),
    });
    await adapter.streamStageAgent(
      piInput({ gate: { daemonUrl: 'http://x', runId: 'r1' } }),
      collecting().handlers,
    );
    expect(capture.inv!.args).not.toContain('--permission-prompt-tool');
    expect(capture.inv!.args).not.toContain('--mcp-config');
  });

  it('produces the stage artifact + sessionId on success', async () => {
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(
        successLines('A substantive execution plan body for discovery.', 'sess-xyz'),
      ),
    });
    const res = await adapter.streamStageAgent(
      piInput({ stage: 'discovery' }),
      collecting().handlers,
    );
    expect(res.status).toBe('succeeded');
    expect(res.sessionId).toBe('sess-xyz');
    expect(res.produced).toHaveLength(1);
    expect(res.produced[0]!.kind).toBe('execution_plan');
    expect(res.produced[0]!.body).toContain('execution plan body');
  });

  it('fails on a non-zero exit code', async () => {
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream(successLines('partial'), 1),
    });
    const res = await adapter.streamStageAgent(piInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/exit 1/);
  });

  it('fails on empty output', async () => {
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: fakeStream([session('s'), turnStart(), agentEnd()], 0),
    });
    const res = await adapter.streamStageAgent(piInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/empty output/);
  });

  it('surfaces a spawn failure as failed (e.g. pi not installed)', async () => {
    const adapter = new PiAgentRuntimeAdapter({
      runCliStreaming: async () => {
        throw new Error('spawn pi ENOENT');
      },
    });
    const res = await adapter.streamStageAgent(piInput(), collecting().handlers);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/failed to run pi CLI/);
  });
});

describe('consumePiStreamLine', () => {
  const fixedNow = () => 1000;

  it('captures the session id from the session header', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(session('sess-7'), acc, handlers, fixedNow);
    expect(acc.sessionId).toBe('sess-7');
    expect(events).toHaveLength(0);
  });

  it('emits a turn event with an index on turn_start', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    // No boundary set in this isolated unit (the adapter sets it at stream start),
    // so ttft is null here. The index + turn count are what this asserts.
    consumePiStreamLine(turnStart(), acc, handlers, fixedNow);
    expect(events).toEqual([{ type: 'turn', payload: { index: 1, ttftMs: null } }]);
    expect(acc.turns).toBe(1);
  });

  it('accumulates text deltas into finalText and emits assistant_text', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(textDelta('Hello '), acc, handlers, fixedNow);
    consumePiStreamLine(textDelta('world'), acc, handlers, fixedNow);
    expect(acc.finalText).toBe('Hello world');
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'Hello ' } },
      { type: 'assistant_text', payload: { text: 'world' } },
    ]);
  });

  it('maps tool_execution_start/end to tool_call/tool_result', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(toolStart('bash', { command: 'ls' }), acc, handlers, fixedNow);
    consumePiStreamLine(toolEnd('bash', 'file.txt', false), acc, handlers, fixedNow);
    expect(events[0]).toEqual({
      type: 'tool_call',
      payload: { name: 'bash', input: { command: 'ls' } },
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
      payload: { status: 'ok', summary: 'file.txt' },
    });
  });

  it('marks a tool error result as status error', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(toolEnd('bash', 'boom', true), acc, handlers, fixedNow);
    expect(events[0]).toEqual({
      type: 'tool_result',
      payload: { status: 'error', summary: 'boom' },
    });
  });

  it('aggregates per-turn token usage and emits cost+result on agent_end', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(turnStart(), acc, handlers, fixedNow);
    consumePiStreamLine(turnEnd({ input: 100, output: 40 }), acc, handlers, fixedNow);
    consumePiStreamLine(turnStart(), acc, handlers, fixedNow);
    consumePiStreamLine(turnEnd({ input: 60, output: 20 }), acc, handlers, fixedNow);
    consumePiStreamLine(agentEnd(), acc, handlers, fixedNow);

    const cost = events.find((e) => e.type === 'cost');
    expect(cost!.payload).toMatchObject({
      totalCostUsd: null,
      numTurns: 2,
      inputTokens: 160,
      outputTokens: 60,
    });
    const result = events.find((e) => e.type === 'result');
    expect(result!.payload).toMatchObject({ subtype: 'success', isError: false });
  });

  it('captures a top-level error event', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine(
      JSON.stringify({ type: 'error', message: 'model overloaded' }),
      acc,
      handlers,
      fixedNow,
    );
    expect(acc.errorMessage).toBe('model overloaded');
    expect(events[0]).toEqual({ type: 'error', payload: { message: 'model overloaded' } });
  });

  it('ignores non-JSON noise', () => {
    const acc = newPiAccumulator();
    const { events, handlers } = collecting();
    consumePiStreamLine('not json', acc, handlers, fixedNow);
    expect(events).toHaveLength(0);
  });
});
