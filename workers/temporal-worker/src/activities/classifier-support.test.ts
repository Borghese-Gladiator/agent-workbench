import { describe, expect, it } from 'vitest';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from '@awb/agent-gateway';
import { classifyTaskSizeWithModel, SIZE_CLASSIFIER_MODEL } from './classifier-support.js';

class FakeClassifierAdapter implements CodingAgentAdapter {
  readonly id = 'fake-classifier';
  lastCreateInput?: CreateAgentSessionInput;
  constructor(private readonly summary: string) {}
  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.lastCreateInput = input;
    return { id: 's1', role: input.role, taskId: input.taskId, providerId: this.id, createdAt: '' };
  }
  async execute(_s: AgentSession, _a: AgentAssignment, _sink: AgentEventSink): Promise<AgentExecutionResult> {
    return { completed: true, findings: [], summary: this.summary };
  }
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const baseInput = {
  taskId: 'task-1',
  cwd: '/tmp/repo',
  signals: { prompt: 'add a feature', targetFileCount: 3 },
  allowedTools: [],
  disallowedTools: [],
};

describe('classifyTaskSizeWithModel (TASK-51)', () => {
  it('uses the heuristic (not the model) when useModel is false (mock profile)', async () => {
    const adapter = new FakeClassifierAdapter('```json\n{"size":"L"}\n```');
    const size = await classifyTaskSizeWithModel({ ...baseInput, adapter, useModel: false, model: SIZE_CLASSIFIER_MODEL });
    // heuristic only — never calls the model (M for 3 files, medium prompt)
    expect(size).toBe('M');
    expect(adapter.lastCreateInput).toBeUndefined();
  });

  it('parses the tiny-model answer on a real-agent profile and requests the small model', async () => {
    const adapter = new FakeClassifierAdapter('My answer:\n```json\n{"size":"L"}\n```');
    const size = await classifyTaskSizeWithModel({ ...baseInput, adapter, useModel: true, model: SIZE_CLASSIFIER_MODEL });
    expect(size).toBe('L');
    expect(adapter.lastCreateInput?.model).toBe(SIZE_CLASSIFIER_MODEL);
  });

  it('falls back to the heuristic when the model output is unparseable', async () => {
    const adapter = new FakeClassifierAdapter('I really cannot tell.');
    const size = await classifyTaskSizeWithModel({ ...baseInput, adapter, useModel: true, model: SIZE_CLASSIFIER_MODEL });
    expect(size).toBe('M');
  });

  it('uses the heuristic when useModel is true but no model is provided', async () => {
    const adapter = new FakeClassifierAdapter('```json\n{"size":"L"}\n```');
    const size = await classifyTaskSizeWithModel({ ...baseInput, adapter, useModel: true });
    expect(size).toBe('M');
    expect(adapter.lastCreateInput).toBeUndefined();
  });
});
