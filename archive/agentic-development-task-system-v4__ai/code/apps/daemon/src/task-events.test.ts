import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@workbench/store';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppOptions, createApp } from './app.js';

/**
 * The task-events SSE stream never self-terminates (a task outlives any single
 * connection), so we can't await a full supertest response like the run-event
 * tests do. Instead we listen on a real port and read the stream with fetch +
 * AbortController: collect chunks until we've seen what we expect, then abort.
 */
let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-taskev-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(opts: Omit<AppOptions, 'onReady'> = { agentFor: () => undefined as never }) {
  return createApp(store, { ...opts, onReady: () => {} });
}

async function makeTask(a: ReturnType<typeof createApp>) {
  const p = await request(a)
    .post('/api/projects')
    .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
  const t = await request(a)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
  return t.body.id as string;
}

/**
 * Open the SSE stream against a really-listening server, run `drive` (which
 * should cause store notifications), and resolve once `untilCount` `changed`
 * events have been read — then abort and close the server.
 */
async function readChanged(
  a: ReturnType<typeof createApp>,
  taskId: string,
  untilCount: number,
  drive: () => void,
): Promise<{ status: number; changedCount: number }> {
  const server = a.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const ctrl = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/events`, {
      signal: ctrl.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (res.status !== 200 || !res.body) return { status: res.status, changedCount: 0 };

    let buf = '';
    let changedCount = 0;
    let driven = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (changedCount < untilCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      changedCount = (buf.match(/event: changed/g) ?? []).length;
      // Fire the driving write AFTER the initial `changed` has landed, so the
      // initial-sync event and the driven event don't race.
      if (!driven && changedCount >= 1) {
        driven = true;
        drive();
      }
    }
    ctrl.abort();
    return { status: 200, changedCount };
  } finally {
    ctrl.abort();
    server.close();
  }
}

describe('daemon API — task events SSE', () => {
  it('404s for an unknown task', async () => {
    const res = await request(app()).get('/api/tasks/task_missing/events');
    expect(res.status).toBe(404);
  });

  it('sends an initial changed event then one per transition', async () => {
    const a = app();
    const id = await makeTask(a);
    // Expect 2: the initial sync + the one from the driven transition.
    const { status, changedCount } = await readChanged(a, id, 2, () => {
      store.applyTransition(id, { stage: 'human_brief_approval', status: 'active' });
    });
    expect(status).toBe(200);
    expect(changedCount).toBeGreaterThanOrEqual(2);
  });

  it('emits a changed event when a new artifact is created', async () => {
    const a = app();
    const id = await makeTask(a);
    const { changedCount } = await readChanged(a, id, 2, () => {
      store.createArtifact({ taskId: id, kind: 'task_brief', title: 'B', body: 'b' });
    });
    expect(changedCount).toBeGreaterThanOrEqual(2);
  });
});
