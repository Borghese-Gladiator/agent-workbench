import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticEvent } from '@awb/domain';
import { createDurableEventSink, createPhaseEventSink } from './durable-event-sink.js';
import type { DaemonClient } from '../daemon-client.js';

function collectingClient(events: SemanticEvent[], opts: { throwOnPost?: boolean } = {}): DaemonClient {
  return {
    async upsertTask() {},
    async saveRunState() {},
    async postEvent(event) {
      if (opts.throwOnPost) throw new Error('daemon down');
      events.push(event);
    },
    async postObservability() {},
  };
}

describe('durable event sink', () => {
  it('normalizes each AgentEvent to a SemanticEvent and posts it (in order)', async () => {
    const posted: SemanticEvent[] = [];
    const { sink, flush } = createDurableEventSink({
      taskId: 'task-1',
      role: 'planner',
      phase: 'plan',
      attemptNumber: 2,
      daemon: collectingClient(posted),
    });

    sink({ type: 'message', text: 'thinking' });
    sink({ type: 'tool-started', tool: 'Read', inputSummary: 'foo.ts' });
    sink({ type: 'usage', usage: { provider: 'anthropic', model: 'claude', inputTokens: 10, outputTokens: 5 } });
    await flush();

    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({
      runId: 'task-1-run',
      phase: 'plan',
      phaseAttemptId: 'task-1-plan-2',
      producer: 'planner',
      type: 'message',
      summary: 'thinking',
    });
    expect(posted[1]?.type).toBe('command-started'); // tool-started maps to command-started
    expect(posted[2]?.type).toBe('usage-reported');
  });

  it('is best-effort: a failing post is captured, never thrown', async () => {
    const { sink, flush, errors } = createDurableEventSink({
      taskId: 'task-1',
      role: 'builder',
      phase: 'implement',
      attemptNumber: 1,
      daemon: collectingClient([], { throwOnPost: true }),
    });
    sink({ type: 'message', text: 'hi' });
    await expect(flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('daemon down');
  });
});

describe('createPhaseEventSink', () => {
  let artifactsDir: string;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'awb-phase-sink-'));
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('durable=false only writes the file log, never posts', async () => {
    const posted: SemanticEvent[] = [];
    const { sink, flush } = createPhaseEventSink({
      artifactsDir,
      taskId: 'task-1',
      role: 'planner',
      phase: 'plan',
      attemptNumber: 1,
      durable: false,
      daemon: collectingClient(posted),
    });
    sink({ type: 'message', text: 'mock run' });
    await flush();
    expect(posted).toHaveLength(0);
  });

  it('durable=true writes the file log AND posts to the daemon', async () => {
    const posted: SemanticEvent[] = [];
    const { sink, flush } = createPhaseEventSink({
      artifactsDir,
      taskId: 'task-1',
      role: 'planner',
      phase: 'plan',
      attemptNumber: 1,
      durable: true,
      daemon: collectingClient(posted),
    });
    sink({ type: 'message', text: 'real run' });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.summary).toBe('real run');
  });
});
