import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@awb/domain';
import type { CliInvocation, RunCliStreaming } from './cli-runtime.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { PiAgentAdapter } from './pi-adapter.js';
import { OpenCodeAgentAdapter } from './opencode-adapter.js';

/**
 * A fake streaming runner: records the invocation it was handed and replays scripted NDJSON lines,
 * so the CLI adapters are exercised end-to-end without spawning a real subprocess.
 */
function fakeRunner(lines: string[], code = 0): { run: RunCliStreaming; invocations: CliInvocation[] } {
  const invocations: CliInvocation[] = [];
  const run: RunCliStreaming = async (invocation, onLine) => {
    invocations.push(invocation);
    for (const line of lines) onLine(line);
    return { code, stderr: '' };
  };
  return { run, invocations };
}

async function drive(
  adapter: CodexAgentAdapter | PiAgentAdapter | OpenCodeAgentAdapter,
  instruction = 'do the thing',
) {
  const session = await adapter.createSession({
    role: 'builder',
    taskId: 'task-1',
    cwd: '/tmp/worktree',
    contextPayload: { contract: 'x' },
    allowedTools: [],
  });
  const events: AgentEvent[] = [];
  const result = await adapter.execute(session, { instruction }, (e) => events.push(e), new AbortController().signal);
  return { result, events };
}

describe('CodexAgentAdapter', () => {
  const codexLines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' }),
    JSON.stringify({ type: 'item.started', item: { item_type: 'command_execution', command: 'npm test' } }),
    JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: 'done building' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 } }),
  ];

  it('parses thread id, agent message, tool + usage into events and a result', async () => {
    const { run } = fakeRunner(codexLines);
    const { result, events } = await drive(new CodexAgentAdapter({ runCliStreaming: run }));
    expect(result.completed).toBe(true);
    expect(result.summary).toContain('done building');
    expect(result.sessionId).toBe('thread-abc');
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 });
    expect(events).toContainEqual({ type: 'message', text: 'done building' });
    expect(events.some((e) => e.type === 'tool-started')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('builds codex exec argv with sandbox + doc-off, prompt last on a cold turn', async () => {
    const { run, invocations } = fakeRunner(codexLines);
    await drive(new CodexAgentAdapter({ runCliStreaming: run }));
    const args = invocations[0]!.args;
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox']);
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args[args.length - 1]).toContain('do the thing');
  });

  it('derives --sandbox from the role capabilities: read-only vs workspace-write', async () => {
    const sandboxFor = async (allowedTools: string[], role: 'builder' | 'adversarial-reviewer') => {
      const { run, invocations } = fakeRunner(codexLines);
      const adapter = new CodexAgentAdapter({ runCliStreaming: run });
      const session = await adapter.createSession({ role, taskId: 't', cwd: '/tmp/w', contextPayload: {}, allowedTools });
      await adapter.execute(session, { instruction: 'go' }, () => {}, new AbortController().signal);
      const args = invocations[0]!.args;
      return args[args.indexOf('--sandbox') + 1];
    };
    // A read-only role (no mutating capability) → read-only; the builder → workspace-write.
    expect(await sandboxFor(['repository.read', 'diff.read'], 'adversarial-reviewer')).toBe('read-only');
    expect(await sandboxFor(['repository.read', 'worktree.write', 'command.run-scoped'], 'builder')).toBe('workspace-write');
  });

  it('fails on a non-zero exit', async () => {
    const { run } = fakeRunner([JSON.stringify({ type: 'item.completed', item: { item_type: 'agent_message', text: 'x' } })], 1);
    const { result } = await drive(new CodexAgentAdapter({ runCliStreaming: run }));
    expect(result.completed).toBe(false);
    expect(result.summary).toContain('exit 1');
  });
});

describe('PiAgentAdapter', () => {
  const piLines = [
    JSON.stringify({ type: 'session', id: 'pi-session-1' }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } }),
    JSON.stringify({ type: 'tool_execution_start', toolName: 'read_file', args: { path: 'a.ts' } }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'read_file', result: 'contents' }),
    JSON.stringify({ type: 'turn_end', message: { usage: { input: 50, output: 10, cacheRead: 3 } } }),
    JSON.stringify({ type: 'agent_end' }),
  ];

  it('concatenates text deltas, aggregates usage, and captures the session id', async () => {
    const { run } = fakeRunner(piLines);
    const { result, events } = await drive(new PiAgentAdapter({ runCliStreaming: run }));
    expect(result.completed).toBe(true);
    expect(result.summary).toBe('hello world');
    expect(result.sessionId).toBe('pi-session-1');
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 10, cachedInputTokens: 3 });
    expect(events).toContainEqual({ type: 'message', text: 'hello ' });
    expect(events.some((e) => e.type === 'tool-completed')).toBe(true);
  });

  it('builds pi --mode json argv with --no-context-files, and --session when resuming', async () => {
    const { run, invocations } = fakeRunner(piLines);
    const adapter = new PiAgentAdapter({ runCliStreaming: run });
    // First (cold) turn captures the session id; a second execute() on the same session resumes it.
    const session = await adapter.createSession({ role: 'builder', taskId: 't', cwd: '/tmp/w', contextPayload: {}, allowedTools: [] });
    await adapter.execute(session, { instruction: 'first' }, () => {}, new AbortController().signal);
    await adapter.execute(session, { instruction: 'second' }, () => {}, new AbortController().signal);
    expect(invocations[0]!.args).toEqual(expect.arrayContaining(['--mode', 'json', '--no-context-files']));
    expect(invocations[0]!.args).not.toContain('--session');
    expect(invocations[1]!.args).toEqual(expect.arrayContaining(['--session', 'pi-session-1']));
  });

  it('enforces the capability boundary structurally via --tools/--exclude-tools', async () => {
    const { run, invocations } = fakeRunner(piLines);
    const adapter = new PiAgentAdapter({ runCliStreaming: run });
    // A read-only role: read/search granted, mutation NOT.
    const session = await adapter.createSession({
      role: 'adversarial-reviewer',
      taskId: 't',
      cwd: '/tmp/w',
      contextPayload: {},
      allowedTools: ['repository.read', 'repository.search'],
    });
    await adapter.execute(session, { instruction: 'review' }, () => {}, new AbortController().signal);
    const args = invocations[0]!.args;
    const toolsArg = args[args.indexOf('--tools') + 1] ?? '';
    const excludeArg = args[args.indexOf('--exclude-tools') + 1] ?? '';
    expect(toolsArg.split(',')).toEqual(expect.arrayContaining(['read', 'grep']));
    expect(toolsArg).not.toContain('edit');
    // The complement is denied explicitly — a read-only Pi run provably cannot mutate.
    expect(excludeArg.split(',')).toEqual(expect.arrayContaining(['edit', 'write', 'bash']));
  });
});

describe('OpenCodeAgentAdapter', () => {
  const ocLines = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'PROBE_OK' } }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: '/tmp/hello.txt' }, output: 'ok' } },
    }),
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_1',
      part: { type: 'step-finish', reason: 'stop', tokens: { input: 17400, output: 4, cache: { read: 0 } }, cost: 0 },
    }),
  ];

  it('parses text, tool + file-change, tokens, and the session id', async () => {
    const { run } = fakeRunner(ocLines);
    const { result, events } = await drive(new OpenCodeAgentAdapter({ runCliStreaming: run }));
    expect(result.completed).toBe(true);
    expect(result.summary).toBe('PROBE_OK');
    expect(result.sessionId).toBe('ses_1');
    expect(result.usage).toMatchObject({ inputTokens: 17400, outputTokens: 4 });
    expect(events).toContainEqual({ type: 'message', text: 'PROBE_OK' });
    expect(events).toContainEqual({ type: 'tool-completed', tool: 'write', resultSummary: 'ok' });
    expect(events).toContainEqual({ type: 'file-changed', path: '/tmp/hello.txt' });
  });

  it('sums per-step output tokens across steps but keeps the latest (cumulative) input', async () => {
    // Token shape from a real 2-step opencode 1.15.3 run: output is per-step (119, then 7 → 126);
    // input re-counts the accumulated context each step (17410 → 17650 → keep the latest).
    const multiStep = [
      JSON.stringify({ type: 'text', sessionID: 'ses_2', part: { type: 'text', text: 'hi' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_2', part: { reason: 'tool-calls', tokens: { input: 17410, output: 119, cache: { read: 0 } } } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_2', part: { reason: 'stop', tokens: { input: 17650, output: 7, cache: { read: 0 } } } }),
    ];
    const { run } = fakeRunner(multiStep);
    const { result } = await drive(new OpenCodeAgentAdapter({ runCliStreaming: run }));
    expect(result.usage).toMatchObject({ inputTokens: 17650, outputTokens: 126 });
  });

  it('builds opencode run --format json argv with the prompt last, --model when set', async () => {
    const { run, invocations } = fakeRunner(ocLines);
    await drive(new OpenCodeAgentAdapter({ runCliStreaming: run, model: 'anthropic/claude-sonnet-4-5' }));
    const args = invocations[0]!.args;
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--dangerously-skip-permissions']);
    expect(args).toEqual(expect.arrayContaining(['--model', 'anthropic/claude-sonnet-4-5']));
    expect(args[args.length - 1]).toContain('do the thing');
  });
});
