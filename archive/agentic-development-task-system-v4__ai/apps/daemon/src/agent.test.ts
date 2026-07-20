import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@workbench/store';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let store: Store;
let dir: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-agent-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
  app = createApp(store);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// The manual `POST /agent/:stage` trigger was removed — agent stages now run only
// through the auto-advance driver (see lifecycle-agent-routing.test.ts). What
// remains here is project-create validation, which is unrelated to that route.
describe('daemon API — projects', () => {
  it('rejects an invalid agentRuntime on project create', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'X', repoPath: '/tmp/x', defaultBranch: 'main', agentRuntime: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('accepts the pi agentRuntime on project create', async () => {
    const res = await request(app).post('/api/projects').send({
      name: 'Pi Proj',
      repoPath: dir, // an existing dir (the temp artifacts dir) satisfies the real-runtime check
      defaultBranch: 'main',
      agentRuntime: 'pi',
    });
    expect(res.status).toBe(201);
    expect(res.body.agentRuntime).toBe('pi');
  });
});
