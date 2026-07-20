import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchClient } from '@workbench/client';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/**
 * Build the server against a fake client, capturing each tool's handler by name.
 * We spy on McpServer.registerTool so we can invoke handlers directly without a
 * live transport.
 */
function buildHarness(clientOverrides: Partial<WorkbenchClient> = {}) {
  const client = {
    listProjects: vi.fn(async () => [{ id: 'p1' }]),
    createProject: vi.fn(async () => ({ id: 'p1' })),
    listTasks: vi.fn(async () => [{ id: 't1' }]),
    createTask: vi.fn(async () => ({ id: 't1' })),
    getTask: vi.fn(async () => ({ task: { id: 't1' } })),
    deleteTask: vi.fn(async () => ({ ok: true })),
    getArtifact: vi.fn(async () => ({ id: 'a1', body: 'hi' })),
    action: vi.fn(async () => ({ id: 't1', stage: 'planning' })),
    worktreeDiff: vi.fn(async () => ({ diff: 'diff' })),
    getActiveRun: vi.fn(async () => ({ run: null })),
    getRun: vi.fn(async () => ({ run: { id: 'r1' }, events: [] })),
    unansweredQuestions: vi.fn(async () => []),
    answerQuestion: vi.fn(async () => ({ id: 'q1' })),
    runEventsUrl: (t: string, r: string) => `http://h/api/tasks/${t}/agent/runs/${r}/events`,
    ...clientOverrides,
  } as unknown as WorkbenchClient;

  const handlers = new Map<string, Handler>();
  // Capture each tool's handler by spying on registerTool before buildServer runs.
  const spy = vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(((
    name: string,
    _config: unknown,
    cb: Handler,
  ) => {
    handlers.set(name, cb);
    return undefined;
  }) as never);
  try {
    buildServer(client);
  } finally {
    spy.mockRestore();
  }
  return { client, handlers };
}

async function call(handlers: Map<string, Handler>, name: string, args: Record<string, unknown>) {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool not registered: ${name}`);
  return h(args);
}

describe('buildServer tool surface', () => {
  it('registers the full tool set', () => {
    const { handlers } = buildHarness();
    for (const name of [
      'list_projects',
      'create_project',
      'list_tasks',
      'create_task',
      'get_task',
      'abandon_task',
      'get_artifact',
      'do_action',
      'worktree_diff',
      'get_active_run',
      'get_run',
      'wait_for_run',
      'unanswered_questions',
      'answer_question',
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  it('get_task delegates to client.getTask and returns its JSON', async () => {
    const { client, handlers } = buildHarness();
    const res = await call(handlers, 'get_task', { taskId: 't9' });
    expect(client.getTask).toHaveBeenCalledWith('t9');
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ task: { id: 't1' } });
  });

  it('do_action passes action path and comment/target through', async () => {
    const { client, handlers } = buildHarness();
    await call(handlers, 'do_action', { taskId: 't1', action: 'reject-brief', comment: 'redo' });
    expect(client.action).toHaveBeenCalledWith('t1', 'reject-brief', {
      comment: 'redo',
      target: undefined,
    });
  });

  it('answer_question sends a text answer when text is given', async () => {
    const { client, handlers } = buildHarness();
    await call(handlers, 'answer_question', { taskId: 't1', questionId: 'q1', text: 'yes' });
    expect(client.answerQuestion).toHaveBeenCalledWith('t1', 'q1', { text: 'yes' });
  });

  it('answer_question sends a selected answer otherwise', async () => {
    const { client, handlers } = buildHarness();
    await call(handlers, 'answer_question', {
      taskId: 't1',
      questionId: 'q1',
      selected: ['Option A'],
    });
    expect(client.answerQuestion).toHaveBeenCalledWith('t1', 'q1', { selected: ['Option A'] });
  });

  it('wait_for_run returns the outcome (idle when no active run)', async () => {
    const { handlers } = buildHarness();
    const res = await call(handlers, 'wait_for_run', { taskId: 't1' });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ outcome: 'idle' });
  });

  it('surfaces a client error as an isError result', async () => {
    const { handlers } = buildHarness({
      getTask: vi.fn(async () => {
        throw new Error('not found');
      }) as unknown as WorkbenchClient['getTask'],
    });
    const res = await call(handlers, 'get_task', { taskId: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('not found');
  });
});
