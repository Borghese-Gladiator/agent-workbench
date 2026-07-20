import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter, StreamHandlers } from '@workbench/agents';
import type { AgentRun, Stage } from '@workbench/core';
import { Store } from '@workbench/store';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunExecutor } from './agent-run-executor.js';
import { type AppOptions, createApp } from './app.js';

/**
 * Build an app and capture a launcher bound to its executor. The production
 * manual-trigger routes were removed, so SSE / run-infrastructure tests start
 * runs through the `onReady` test seam (see AppOptions.onReady) — the same
 * executor the SSE read endpoints serve from.
 */
function appWith(
  store: Store,
  opts: Omit<AppOptions, 'onReady'>,
): { app: ReturnType<typeof createApp>; startRun: (taskId: string, stage: Stage) => AgentRun } {
  let startRun!: (taskId: string, stage: Stage) => AgentRun;
  const app = createApp(store, { ...opts, onReady: (h) => (startRun = h.startRun) });
  return { app, startRun };
}

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-stream-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An adapter whose streaming run emits scripted events then succeeds. */
function scriptedAdapter(): AgentRuntimeAdapter {
  return {
    async runStageAgent() {
      throw new Error('streaming path expected');
    },
    async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
      handlers.onEvent({ type: 'assistant_text', payload: { text: 'working' } });
      handlers.onEvent({ type: 'tool_call', payload: { name: 'Read' } });
      handlers.onEvent({
        type: 'cost',
        payload: { totalCostUsd: 0.01, numTurns: 2, durationApiMs: 4200 },
      });
      return {
        status: 'succeeded' as const,
        transcript: { kind: 'log' as const, title: 't', body: 'transcript body' },
        produced: [{ kind: 'discovery' as const, title: 'd', body: 'PRODUCED' }],
      };
    },
  };
}

/**
 * An adapter that raises one structured question mid-run, then echoes the
 * answer into its produced artifact and succeeds.
 */
function questioningAdapter(): AgentRuntimeAdapter {
  return {
    async runStageAgent() {
      throw new Error('streaming path expected');
    },
    async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
      handlers.onEvent({ type: 'assistant_text', payload: { text: 'thinking' } });
      const answer = await handlers.requestInput({
        header: 'Approach',
        question: 'Which approach?',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
        multiSelect: false,
      });
      const chosen = 'selected' in answer ? answer.selected.join(',') : answer.text;
      return {
        status: 'succeeded' as const,
        transcript: { kind: 'log' as const, title: 't', body: 'done' },
        produced: [{ kind: 'execution_plan' as const, title: 'p', body: `CHOSE:${chosen}` }],
      };
    },
  };
}

/**
 * An adapter whose streaming run hangs until the external stop `signal` aborts,
 * then resolves a failed `stopped by operator` result — modelling the claude
 * adapter's SIGKILL-on-abort path without spawning a real process.
 */
function hangingAdapter(): AgentRuntimeAdapter {
  return {
    async runStageAgent() {
      throw new Error('streaming path expected');
    },
    async streamStageAgent(input: AgentRunInput, handlers: StreamHandlers) {
      handlers.onEvent({ type: 'assistant_text', payload: { text: 'working…' } });
      const signal = input.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      handlers.onEvent({ type: 'error', payload: { message: 'stopped by operator' } });
      return {
        status: 'failed' as const,
        transcript: { kind: 'log' as const, title: 't', body: 'stopped' },
        produced: [],
        error: 'claude run did not succeed (stopped by operator)',
      };
    },
  };
}

async function makeTask(
  app: ReturnType<typeof createApp>,
  projectBody: Record<string, unknown> = {},
) {
  const p = await request(app)
    .post('/api/projects')
    .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main', ...projectBody });
  const t = await request(app)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
  return t.body.id as string;
}

/** Poll the run record until it reaches a terminal status (or times out). */
async function waitForTerminal(
  app: ReturnType<typeof createApp>,
  taskId: string,
  runId: string,
): Promise<{
  run: {
    status: string;
    totalCostUsd: number | null;
    numTurns: number | null;
    durationApiMs: number | null;
  };
  events: { type: string }[];
}> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/tasks/${taskId}/agent/runs/${runId}`);
    const status = res.body?.run?.status;
    if (status === 'succeeded' || status === 'failed') return res.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not reach a terminal status');
}

describe('daemon API — streaming agent runs', () => {
  it('starts a streaming run, streams events, persists artifacts, succeeds', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);

    const run0 = startRun(id, 'discovery');
    expect(run0.id).toBeTruthy();
    const runId = run0.id;

    const { run, events } = await waitForTerminal(app, id, runId);
    expect(run.status).toBe('succeeded');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['assistant_text', 'tool_call', 'cost']),
    );
    // The `cost` event must be persisted onto the run record (not just streamed)
    // so the Task View can show cost/turns on reload.
    expect(run.totalCostUsd).toBe(0.01);
    expect(run.numTurns).toBe(2);
    // `durationApiMs` (true model-API latency) is persisted on the row too.
    expect(run.durationApiMs).toBe(4200);

    // Produced artifacts landed on the task; the stage did NOT advance.
    const detail = await request(app).get(`/api/tasks/${id}`);
    const kinds = detail.body.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toContain('discovery');
    expect(kinds).toContain('log');
    expect(detail.body.task.stage).toBe('intake');
  });

  it('starts a streaming run on the implementation stage', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);
    const run = startRun(id, 'implementation');
    expect(run.id).toBeTruthy();
    await waitForTerminal(app, id, run.id);
  });

  it('the SSE endpoint replays persisted events after the run finished', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    await waitForTerminal(app, id, runId);

    // After terminal, the SSE endpoint replays the stored stream and ends.
    const sse = await request(app).get(`/api/tasks/${id}/agent/runs/${runId}/events`);
    expect(sse.status).toBe(200);
    expect(sse.text).toContain('event: assistant_text');
    expect(sse.text).toContain('event: tool_call');
    expect(sse.text).toMatch(/id: \d+/);
  });

  it('SSE replay honors Last-Event-ID: no duplicate, no gap on reconnect', async () => {
    // A finished run with a known event log. Reconnecting from a mid-stream
    // cursor must replay ONLY the tail (seq > cursor), exactly once each.
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    await waitForTerminal(app, id, runId);

    const all = store.listAgentRunEvents(runId);
    expect(all.length).toBeGreaterThan(2);
    const cursor = all[1]!.seq; // reconnect as if seq 1..cursor were already seen

    const sse = await request(app)
      .get(`/api/tasks/${id}/agent/runs/${runId}/events`)
      .set('Last-Event-ID', String(cursor));
    expect(sse.status).toBe(200);

    const seqs = [...sse.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    // Strictly the tail after the cursor: nothing at/below it, no duplicates,
    // and contiguous through the last persisted seq.
    expect(seqs.every((s) => s > cursor)).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(all.filter((e) => e.seq > cursor).map((e) => e.seq));
  });

  it('SSE handoff is gap-free for an event appended during the replay window', async () => {
    // Reproduces the replay->subscribe race: an event broadcast while the
    // handler is mid-handoff must still reach the client exactly once. We open
    // the SSE request against an in-flight run, then append one more event; the
    // subscribe-before-replay + buffer flush must deliver it.
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('streaming path expected');
      },
      async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'one' } });
        await gate; // hold mid-run until the test has captured the stream
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'two' } });
        handlers.onEvent({
          type: 'result',
          payload: { subtype: 'success', isError: false, denials: [] },
        });
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [],
        };
      },
    };
    const { app, startRun } = appWith(store, { agentFor: () => adapter });
    const runId = startRun(task.id, 'discovery').id;
    // Wait until the first event is persisted (run is in flight, mid-gate).
    for (let i = 0; i < 50 && store.listAgentRunEvents(runId).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Open the SSE stream, then release the run so 'two' + terminal are emitted
    // after the request has begun — supertest resolves when the daemon ends the
    // response on terminal.
    const ssePromise = request(app).get(`/api/tasks/${task.id}/agent/runs/${runId}/events`);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const sse = await ssePromise;

    const seqs = [...sse.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const all = store.listAgentRunEvents(runId).map((e) => e.seq);
    // Every persisted event delivered exactly once, in order — no gap, no dup.
    expect(seqs).toEqual(all);
    expect(sse.text).toContain('data: {"text":"one"}');
    expect(sse.text).toContain('data: {"text":"two"}');
    expect(sse.text).toContain('event: result');
  });

  it('delivers an event broadcast in the subscribe→replay window (race regression)', async () => {
    // This is the white-box version of the race: the SSE handler invokes
    // `onSseBeforeReplay` AFTER subscribing but BEFORE replaying. The hook
    // releases an in-flight run so it broadcasts another event right then. A
    // replay-then-subscribe handler would miss that event; subscribe-before-
    // replay buffers it. We prove it's delivered exactly once.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('streaming path expected');
      },
      async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'before' } });
        await gate; // released from inside the SSE handler's race window
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'in-window' } });
        handlers.onEvent({
          type: 'result',
          payload: { subtype: 'success', isError: false, denials: [] },
        });
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [],
        };
      },
    };

    let fired = false;
    const { app, startRun } = appWith(store, {
      agentFor: () => adapter,
      onSseBeforeReplay: async (runId) => {
        // Only trip the race once (the run reconnects per SSE request otherwise).
        if (fired) return;
        fired = true;
        const before = store.listAgentRunEvents(runId).length;
        release(); // broadcast 'in-window' + terminal through the live bus now
        // Wait until those events have been persisted+fanned out, so they land
        // in this handler's subscription buffer before we return to replay.
        for (let i = 0; i < 100 && store.listAgentRunEvents(runId).length <= before; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    // Let the adapter emit its first event and park on the gate.
    for (let i = 0; i < 50 && store.listAgentRunEvents(runId).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const sse = await request(app).get(`/api/tasks/${id}/agent/runs/${runId}/events`);
    const seqs = [...sse.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const all = store.listAgentRunEvents(runId).map((e) => e.seq);
    // The 'in-window' event (and terminal) are present, each exactly once, in
    // order — none dropped in the handoff.
    expect(seqs).toEqual(all);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(sse.text).toContain('data: {"text":"in-window"}');
    expect(sse.text).toContain('event: result');
  });

  it('reports the active run while in flight and null after terminal', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => questioningAdapter() });
    const id = await makeTask(app);

    // No runs yet.
    const before = await request(app).get(`/api/tasks/${id}/agent/runs/active`);
    expect(before.status).toBe(200);
    expect(before.body.run).toBeNull();

    // While paused awaiting input, the run is still "active".
    const runId = startRun(id, 'discovery').id;
    await waitForStatus(app, id, runId, 'awaiting_input');
    const during = await request(app).get(`/api/tasks/${id}/agent/runs/active`);
    expect(during.body.run?.id).toBe(runId);
    expect(during.body.run?.status).toBe('awaiting_input');

    // After terminal, active goes back to null.
    const q = (await request(app).get(`/api/tasks/${id}/questions/unanswered`)).body[0];
    await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['A'] } });
    await waitForStatus(app, id, runId, 'succeeded');
    const after = await request(app).get(`/api/tasks/${id}/agent/runs/active`);
    expect(after.body.run).toBeNull();

    // Unknown task -> 404.
    const missing = await request(app).get('/api/tasks/nope/agent/runs/active');
    expect(missing.status).toBe(404);
  });

  it("lists a task's runs oldest-first; empty for an unknown task", async () => {
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);

    // No runs yet.
    const empty = await request(app).get(`/api/tasks/${id}/agent/runs`);
    expect(empty.status).toBe(200);
    expect(empty.body.runs).toEqual([]);

    // One finished run shows up (the UI pins its terminal to the newest run).
    const runId = startRun(id, 'discovery').id;
    await waitForTerminal(app, id, runId);
    const listed = await request(app).get(`/api/tasks/${id}/agent/runs`);
    expect(listed.body.runs).toHaveLength(1);
    expect(listed.body.runs[0].id).toBe(runId);
    expect(listed.body.runs[0].status).toBe('succeeded');

    // Unknown task -> empty list (listAgentRuns doesn't 404).
    const unknown = await request(app).get('/api/tasks/nope/agent/runs');
    expect(unknown.status).toBe(200);
    expect(unknown.body.runs).toEqual([]);
  });

  it('stops an in-flight run -> flips it to failed', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => hangingAdapter() });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    await waitForStatus(app, id, runId, 'running');

    const stopped = await request(app).post(`/api/tasks/${id}/agent/runs/${runId}/stop`);
    expect(stopped.status).toBe(200);
    await waitForStatus(app, id, runId, 'failed');
    const record = await request(app).get(`/api/tasks/${id}/agent/runs/${runId}`);
    expect(record.body.run.status).toBe('failed');
    expect(record.body.run.error).toContain('stopped by operator');
  });

  it('stopping a terminal run -> 409; an unknown run -> 404', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => scriptedAdapter() });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    await waitForTerminal(app, id, runId);

    const late = await request(app).post(`/api/tasks/${id}/agent/runs/${runId}/stop`);
    expect(late.status).toBe(409);

    const missing = await request(app).post(`/api/tasks/${id}/agent/runs/nope/stop`);
    expect(missing.status).toBe(404);
  });

  it('markInterruptedRuns marks a stuck run interrupted (simulating a daemon restart)', async () => {
    // A run left running with no executor backing it (orphan).
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });

    const interrupted = store.markInterruptedRuns();
    expect(interrupted.map((r) => r.id)).toEqual([run.id]);
    expect(store.getAgentRun(run.id)!.status).toBe('interrupted');
    // The sweep must terminate the event log too, or an attached SSE client
    // replays forever waiting for a terminal event.
    const events = store.listAgentRunEvents(run.id);
    expect(events[events.length - 1]!.type).toBe('error');
  });
});

/** Poll the run until it reaches a given status (or times out). */
async function waitForStatus(
  app: ReturnType<typeof createApp>,
  taskId: string,
  runId: string,
  status: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/tasks/${taskId}/agent/runs/${runId}`);
    if (res.body?.run?.status === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run did not reach status ${status}`);
}

describe('AgentRunExecutor.run (awaited lifecycle runs)', () => {
  it('resolves with a failed outcome (never rejects) when the adapter throws', async () => {
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    const throwing: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('kaboom');
      },
    };
    const executor = new AgentRunExecutor(store);

    const outcome = await executor.run({
      taskId: task.id,
      stage: 'discovery',
      adapter: throwing,
      contextArtifactIds: [],
      allowedTools: [],
      taskTitle: 'T',
      rawRequest: 'r',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('kaboom');
    expect(store.getAgentRun(outcome.run.id)!.status).toBe('failed');
    const types = store.listAgentRunEvents(outcome.run.id).map((e) => e.type);
    expect(types).toContain('error');
  });

  it('persists a `turn` event with receivedAt and its per-turn ttft/token payload', async () => {
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('streaming path expected');
      },
      async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
        // A slow turn (> the WARN threshold) carrying per-turn usage.
        handlers.onEvent({
          type: 'turn',
          payload: {
            index: 1,
            ttftMs: 65_000,
            inputTokens: 140_000,
            outputTokens: 900,
            cacheReadInputTokens: 110_000,
            cacheCreationInputTokens: 0,
          },
        });
        handlers.onEvent({
          type: 'result',
          payload: { subtype: 'success', isError: false, denials: [] },
        });
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [],
        };
      },
    };
    const executor = new AgentRunExecutor(store);

    const outcome = await executor.run({
      taskId: task.id,
      stage: 'discovery',
      adapter,
      contextArtifactIds: [],
      allowedTools: [],
      taskTitle: 'T',
      rawRequest: 'r',
    });

    const turn = store.listAgentRunEvents(outcome.run.id).find((e) => e.type === 'turn');
    expect(turn).toBeDefined();
    expect(turn!.receivedAt).not.toBeNull();
    expect(turn!.payload).toMatchObject({ index: 1, ttftMs: 65_000, inputTokens: 140_000 });
    // The first turn's TTFT is also lifted onto the run row.
    expect(store.getAgentRun(outcome.run.id)!.ttftMs).toBe(65_000);
  });

  it('emits the terminal result only after artifacts and run status are persisted', async () => {
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Adapter that (like the real CLI) emits `result` well before it returns.
    const adapter: AgentRuntimeAdapter = {
      async runStageAgent() {
        throw new Error('streaming path expected');
      },
      async streamStageAgent(_input: AgentRunInput, handlers: StreamHandlers) {
        await gate; // let the test subscribe first
        handlers.onEvent({ type: 'assistant_text', payload: { text: 'hi' } });
        handlers.onEvent({
          type: 'result',
          payload: { subtype: 'success', isError: false, denials: [] },
        });
        await new Promise((r) => setTimeout(r, 20)); // CLI shutdown lag
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [],
        };
      },
    };
    const executor = new AgentRunExecutor(store);

    let persisted = false;
    let atResult: { status: string; persisted: boolean } | null = null;
    const run = executor.start({
      taskId: task.id,
      stage: 'discovery',
      adapter,
      contextArtifactIds: [],
      allowedTools: [],
      taskTitle: 'T',
      rawRequest: 'r',
      persistResult: () => {
        persisted = true;
      },
    });
    executor.subscribe(run.id, (ev) => {
      if (ev.type === 'result') {
        atResult = { status: store.getAgentRun(run.id)!.status, persisted };
      }
    });
    release();

    for (let i = 0; i < 50 && !atResult; i++) await new Promise((r) => setTimeout(r, 10));
    expect(atResult).toEqual({ status: 'succeeded', persisted: true });
  });

  it('stop() returns false for an unknown / already-finished run', async () => {
    const executor = new AgentRunExecutor(store);
    expect(executor.stop('nope')).toBe(false);
  });

  it('stop() aborts a live run and it resolves failed', async () => {
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    const executor = new AgentRunExecutor(store);
    const run = executor.start({
      taskId: task.id,
      stage: 'discovery',
      adapter: hangingAdapter(),
      contextArtifactIds: [],
      allowedTools: [],
      taskTitle: 'T',
      rawRequest: 'r',
    });
    // Let the run register its aborter, then stop it.
    for (let i = 0; i < 50 && !executor.stop(run.id); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (let i = 0; i < 50 && store.getAgentRun(run.id)!.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(store.getAgentRun(run.id)!.status).toBe('failed');
  });

  it('synthesizes a terminal result event for one-shot fallback adapters', async () => {
    const project = store.createProject({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'r' });
    const oneShot: AgentRuntimeAdapter = {
      async runStageAgent() {
        return {
          status: 'succeeded' as const,
          transcript: { kind: 'log' as const, title: 't', body: 'b' },
          produced: [],
        };
      },
    };
    const executor = new AgentRunExecutor(store);

    const outcome = await executor.run({
      taskId: task.id,
      stage: 'discovery',
      adapter: oneShot,
      contextArtifactIds: [],
      allowedTools: [],
      taskTitle: 'T',
      rawRequest: 'r',
    });

    expect(outcome.status).toBe('succeeded');
    const events = store.listAgentRunEvents(outcome.run.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('result');
  });
});

describe('daemon API — mid-run question gate', () => {
  it('pauses awaiting_input, surfaces the question, resumes on answer', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => questioningAdapter() });
    const id = await makeTask(app);

    const runId = startRun(id, 'discovery').id;

    // The run parks awaiting input.
    await waitForStatus(app, id, runId, 'awaiting_input');

    // The question is unanswered + surfaced on the task and as an event.
    const unanswered = await request(app).get(`/api/tasks/${id}/questions/unanswered`);
    expect(unanswered.body).toHaveLength(1);
    const q = unanswered.body[0];
    expect(q.question).toBe('Which approach?');
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['A', 'B']);

    const record = await request(app).get(`/api/tasks/${id}/agent/runs/${runId}`);
    expect(record.body.events.map((e: { type: string }) => e.type)).toContain('ask_question');

    // Answer it -> run resumes and succeeds, echoing the choice into the artifact.
    const ans = await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['B'] } });
    expect(ans.status).toBe(200);

    await waitForStatus(app, id, runId, 'succeeded');
    const detail = await request(app).get(`/api/tasks/${id}`);
    const plan = detail.body.artifacts.find((a: { kind: string }) => a.kind === 'execution_plan');
    const body = await request(app).get(`/api/artifacts/${plan.id}`);
    expect(body.body.body).toContain('CHOSE:B');

    // No unanswered questions remain.
    const after = await request(app).get(`/api/tasks/${id}/questions/unanswered`);
    expect(after.body).toHaveLength(0);
  });

  it('validates the answer shape (400) and rejects double-answer (409)', async () => {
    const { app, startRun } = appWith(store, { agentFor: () => questioningAdapter() });
    const id = await makeTask(app);
    const runId = startRun(id, 'discovery').id;
    await waitForStatus(app, id, runId, 'awaiting_input');
    const q = (await request(app).get(`/api/tasks/${id}/questions/unanswered`)).body[0];

    // Free-text answer to a multiple-choice question -> 400.
    const bad = await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { text: 'whatever' } });
    expect(bad.status).toBe(400);

    // Unknown option -> 400.
    const badOpt = await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['Z'] } });
    expect(badOpt.status).toBe(400);

    // Valid answer -> 200; a second answer -> 409.
    const ok = await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['A'] } });
    expect(ok.status).toBe(200);
    await waitForStatus(app, id, runId, 'succeeded');

    const again = await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['B'] } });
    expect(again.status).toBe(409);
  });
});
