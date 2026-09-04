import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticEvent } from '@awb/domain';
import { createDaemonClient } from './daemon-client.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

describe('daemon client', () => {
  let calls: Call[];
  let status: number;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    status = 200;
    process.env.AWB_DAEMON_URL = 'http://127.0.0.1:9999';
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ ok: status < 400 }), { status });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.AWB_DAEMON_URL;
  });

  it('PUTs a task-state sync to the configured daemon URL', async () => {
    await createDaemonClient().syncTaskState({
      taskId: 'task-1',
      repositoryId: 'repo-1',
      prompt: 'p',
      phase: 'implement',
      condition: 'running',
      deliveryState: 'not-started',
      pendingGateReason: null,
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/internal/tasks/task-1');
    expect(calls[0]?.body).toEqual({
      repositoryId: 'repo-1',
      prompt: 'p',
      phase: 'implement',
      condition: 'running',
      deliveryState: 'not-started',
      pendingGateReason: null,
    });
  });

  it('POSTs a semantic event', async () => {
    const event: SemanticEvent = {
      id: 'e1',
      runId: 'r1',
      sequence: 0,
      occurredAt: new Date().toISOString(),
      phase: 'plan',
      phaseAttemptId: 'r1-plan-1',
      producer: 'planner',
      type: 'message',
      summary: 'hi',
    };
    await createDaemonClient().postEvent(event);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/internal/events');
    expect(calls[0]?.body).toEqual(event);
  });

  it('POSTs a validated start command to the repository commands route', async () => {
    await createDaemonClient().persistStartCommand({
      repositoryId: 'repo-1',
      command: 'npm run dev',
      cwd: '/w/tree',
      validatedAtSha: 'abc123',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/internal/repositories/repo-1/commands');
    expect(calls[0]?.body).toEqual({ command: 'npm run dev', cwd: '/w/tree', validatedAtSha: 'abc123' });
  });

  it('throws on a non-2xx response', async () => {
    status = 500;
    await expect(
      createDaemonClient().syncTaskState({
        taskId: 'task-1',
        repositoryId: 'repo-1',
        prompt: 'p',
        phase: 'specify',
        condition: 'running',
        deliveryState: 'not-started',
      }),
    ).rejects.toThrow(/returned 500/);
  });
});
