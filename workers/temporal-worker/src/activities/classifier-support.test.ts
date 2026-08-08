import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from '@awb/agent-gateway';
import { classifyTaskSize, SIZE_CLASSIFIER_MODEL } from './classifier-support.js';

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
  phase: 'specify' as const,
  attemptNumber: 1,
  cwd: '/tmp/repo',
  input: { prompt: 'add a feature' },
  allowedTools: [],
  disallowedTools: [],
};

afterEach(() => {
  delete process.env.AWB_CLASSIFIER_SHADOW;
  delete process.env.AWB_SHADOW_CLASSIFIER_MODEL;
  delete process.env.AWB_OLLAMA_HOST;
});

describe('classifyTaskSize (TASK-51 authoritative path)', () => {
  it('returns undefined when useModel is false (no model call)', async () => {
    const adapter = new FakeClassifierAdapter('```json\n{"size":"L"}\n```');
    const result = await classifyTaskSize({ ...baseInput, adapter, useModel: false, model: SIZE_CLASSIFIER_MODEL });
    expect(result).toBeUndefined();
    expect(adapter.lastCreateInput).toBeUndefined();
  });

  it('returns undefined when useModel is true but no model is provided', async () => {
    const adapter = new FakeClassifierAdapter('```json\n{"size":"L"}\n```');
    const result = await classifyTaskSize({ ...baseInput, adapter, useModel: true });
    expect(result).toBeUndefined();
    expect(adapter.lastCreateInput).toBeUndefined();
  });

  it('parses the model answer and requests the small model', async () => {
    const adapter = new FakeClassifierAdapter('My answer:\n```json\n{"size":"L","reasonCodes":["security_sensitive"]}\n```');
    const result = await classifyTaskSize({ ...baseInput, adapter, useModel: true, model: SIZE_CLASSIFIER_MODEL });
    expect(result?.size).toBe('L');
    expect(result?.reasonCodes).toEqual(['security_sensitive']);
    expect(adapter.lastCreateInput?.model).toBe(SIZE_CLASSIFIER_MODEL);
  });

  it('returns undefined when the model output is unparseable (contract default then applies)', async () => {
    const adapter = new FakeClassifierAdapter('I really cannot tell.');
    const result = await classifyTaskSize({ ...baseInput, adapter, useModel: true, model: SIZE_CLASSIFIER_MODEL });
    expect(result).toBeUndefined();
  });
});

describe('classifyTaskSize (TASK-51 shadow path)', () => {
  it('still returns the authoritative answer when the shadow model is unreachable', async () => {
    // Enable shadow but point Ollama at a dead port so the local fetch fails — the authoritative
    // (Haiku) answer must be unaffected and the task must not throw.
    process.env.AWB_CLASSIFIER_SHADOW = '1';
    process.env.AWB_OLLAMA_HOST = 'http://127.0.0.1:1'; // nothing listens here
    const adapter = new FakeClassifierAdapter('```json\n{"size":"M"}\n```');
    const result = await classifyTaskSize({ ...baseInput, adapter, useModel: true, model: SIZE_CLASSIFIER_MODEL });
    expect(result?.size).toBe('M');
  });
});
