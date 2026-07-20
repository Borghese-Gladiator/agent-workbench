import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIFECYCLE_ACTIONS } from '@workbench/core';
import { Store } from '@workbench/store';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let store: Store;
let dir: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-daemon-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
  app = createApp(store);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function makeTask() {
  const p = await request(app)
    .post('/api/projects')
    .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
  const t = await request(app)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
  return t.body.id as string;
}

describe('daemon API — full mock lifecycle (auto-advance)', () => {
  it('walks a task from intake to closeout, gated only at the 4 human gates', async () => {
    const id = await makeTask();

    const step = async (path: string, body: object = {}) => {
      const res = await request(app).post(`/api/tasks/${id}/${path}`).send(body);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body;
    };

    // Intake -> task_brief is still manual (first-gate-manual decision).
    expect((await step('generate-brief')).stage).toBe('human_brief_approval');

    // GATE 1: approving the brief auto-advances discovery -> baseline ->
    // plan, parking at the plan gate. No manual non-gate steps.
    expect((await step('approve-brief')).stage).toBe('human_plan_approval');

    // GATE 2: approving the plan auto-advances implementation -> validation ->
    // self-review, parking at the review gate.
    expect((await step('approve-plan')).stage).toBe('human_review');

    // GATE 3: completing review auto-advances delivery_prep, parking at the
    // delivery gate.
    expect((await step('review/complete')).stage).toBe('human_delivery_approval');

    // GATE 4: approving delivery auto-advances publish -> closeout (terminal).
    const closed = await step('approve-delivery');
    expect(closed.stage).toBe('closeout');
    expect(closed.status).toBe('done');

    // The non-gate routes are gone from the HTTP surface.
    const gone = await request(app).post(`/api/tasks/${id}/discovery`).send({});
    expect(gone.status).toBe(404);

    // Artifacts accumulated along the way (produced by the driver internally).
    const detail = await request(app).get(`/api/tasks/${id}`);
    const kinds = detail.body.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toContain('task_brief');
    expect(kinds).toContain('execution_plan');
    expect(kinds).toContain('validation_report');
    expect(kinds).toContain('delivery_package');
    // Closeout no longer produces an artifact — the timeline already has plenty.
    expect(kinds).not.toContain('closeout_summary');
    expect(detail.body.worktree?.status).toBe('stub');
  });

  it('rejects an illegal transition with 409', async () => {
    const id = await makeTask();
    const res = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(res.status).toBe(409);
  });

  it('lists demo assets with their kind and serves them with a content-type', async () => {
    const id = await makeTask();
    // Seed the durable demo-assets a verification run would have captured.
    for (const [name, data] of [
      ['video.webm', 'WEBM'],
      ['shot.png', 'PNG'],
      ['trace.zip', 'ZIP'],
    ]) {
      const src = join(dir, name!);
      writeFileSync(src, data!);
      store.copyDemoAsset(id, src);
    }

    const list = await request(app).get(`/api/tasks/${id}/assets`);
    expect(list.status).toBe(200);
    expect(list.body.assets).toEqual([
      { name: 'shot.png', kind: 'image' },
      { name: 'trace.zip', kind: 'trace' },
      { name: 'video.webm', kind: 'video' },
    ]);

    const img = await request(app).get(`/api/tasks/${id}/assets/shot.png`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    const vid = await request(app).get(`/api/tasks/${id}/assets/video.webm`);
    expect(vid.status).toBe(200);
    expect(vid.headers['content-type']).toContain('video/webm');
  });

  it('404s on a missing or traversal asset name; 404s assets for unknown task', async () => {
    const id = await makeTask();
    expect((await request(app).get(`/api/tasks/${id}/assets/nope.png`)).status).toBe(404);
    expect((await request(app).get(`/api/tasks/${id}/assets/..%2f..%2fsecret`)).status).toBe(404);
    expect((await request(app).get('/api/tasks/does-not-exist/assets')).status).toBe(404);
  });

  it('returns an empty asset list for a task that captured none', async () => {
    const id = await makeTask();
    const res = await request(app).get(`/api/tasks/${id}/assets`);
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
  });

  it('blocks a gate approval (409) while an agent question is unanswered', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/generate-brief`).send({});

    // Simulate an agent run that raised a question on this task but is still
    // unanswered (e.g. a permission/clarification gate).
    const run = store.createAgentRun({ taskId: id, stage: 'task_brief' });
    const q = store.createAgentQuestion({
      runId: run.id,
      taskId: id,
      header: 'Clarify',
      question: 'Which scope?',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      multiSelect: false,
    });

    // Approving the brief gate is blocked until the question is answered.
    const blocked = await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.error).toMatch(/answer the open question/i);

    // Answer it, then the gate clears and the task auto-advances.
    await request(app)
      .post(`/api/tasks/${id}/agent/questions/${q.id}/answer`)
      .send({ answer: { selected: ['A'] } });
    const ok = await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('human_plan_approval');
  });

  it('bounce from human_review re-enters the driver and parks at the next gate', async () => {
    const id = await makeTask();
    const step = (path: string, body: object = {}) =>
      request(app).post(`/api/tasks/${id}/${path}`).send(body);
    await step('generate-brief');
    await step('approve-brief'); // -> human_plan_approval
    await step('approve-plan'); // -> human_review

    // Bounce to implementation: the driver re-runs implementation ->
    // validation -> self-review and parks back at human_review.
    const bounced = await step('review/bounce', { target: 'implementation', comment: 'fix X' });
    expect(bounced.body.stage).toBe('human_review');

    const detail = await request(app).get(`/api/tasks/${id}`);
    const kinds = detail.body.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toContain('bounce_packet');
  });

  it.each([
    { target: 'banana' },
    { target: '' },
    {},
  ])('bounce with an unknown target is rejected with 400 (no silent coerce): %o', async (body) => {
    const id = await makeTask();
    const step = (path: string, b: object = {}) =>
      request(app).post(`/api/tasks/${id}/${path}`).send(b);
    // Only gate routes exist; approve-brief and approve-plan auto-advance the
    // agent stretches between them, parking the task at human_review.
    await step('generate-brief');
    await step('approve-brief');
    await step('approve-plan');

    const res = await step('review/bounce', body);
    expect(res.status).toBe(400);

    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.stage).toBe('human_review');
  });

  it('reject-brief auto-regenerates with the comment and parks back at the gate', async () => {
    const id = await makeTask();
    const step = (path: string, body: object = {}) =>
      request(app).post(`/api/tasks/${id}/${path}`).send(body);

    await step('generate-brief'); // -> human_brief_approval (V1)
    // Reject in ONE motion: it produces a revised brief and returns to the gate
    // (no manual "Regenerate" step, no stale brief left on screen).
    const rejected = await step('reject-brief', { comment: 'make it more concise' });
    expect(rejected.body.stage).toBe('human_brief_approval');

    const detail = await request(app).get(`/api/tasks/${id}`);
    const briefs = detail.body.artifacts.filter((a: { kind: string }) => a.kind === 'task_brief');
    expect(briefs).toHaveLength(2);
    // The mock runtime has no session to resume, so the comment is threaded into
    // the regenerated brief as reviewer feedback.
    const v2 = await request(app).get(`/api/artifacts/${briefs[1].id}`);
    expect(v2.body.body).toContain('make it more concise');
  });

  it('reject-plan threads the comment into the regenerated plan', async () => {
    const id = await makeTask();
    const step = (path: string, body: object = {}) =>
      request(app).post(`/api/tasks/${id}/${path}`).send(body);

    await step('generate-brief');
    await step('approve-brief'); // auto-advances to human_plan_approval
    // Rejecting re-runs the plan stage and parks back at the plan gate.
    const rejected = await step('reject-plan', { comment: 'add a rollback step' });
    expect(rejected.body.stage).toBe('human_plan_approval');

    const detail = await request(app).get(`/api/tasks/${id}`);
    const plans = detail.body.artifacts.filter(
      (a: { kind: string }) => a.kind === 'execution_plan',
    );
    const latest = await request(app).get(`/api/artifacts/${plans[plans.length - 1].id}`);
    expect(latest.body.body).toContain('add a rollback step');
  });

  it('bounce renders the reviewer comment in the bounce_packet', async () => {
    const id = await makeTask();
    const step = (path: string, body: object = {}) =>
      request(app).post(`/api/tasks/${id}/${path}`).send(body);

    await step('generate-brief');
    await step('approve-brief'); // -> human_plan_approval
    await step('approve-plan'); // -> human_review
    await step('review/bounce', { target: 'implementation', comment: 'tests are missing' });

    const detail = await request(app).get(`/api/tasks/${id}`);
    const packet = detail.body.artifacts.find((a: { kind: string }) => a.kind === 'bounce_packet');
    const body = await request(app).get(`/api/artifacts/${packet.id}`);
    expect(body.body.body).toContain('tests are missing');
    expect(body.body.body).not.toContain('Reviewer feedback summarized here');
  });

  it.each([
    'reject-brief',
    'reject-plan',
    'reject-delivery',
  ])('%s without a comment is rejected with 400', async (endpoint) => {
    const id = await makeTask();
    const res = await request(app).post(`/api/tasks/${id}/${endpoint}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comment is required/i);
  });

  it('review/bounce without a comment is rejected with 400', async () => {
    const id = await makeTask();
    const res = await request(app)
      .post(`/api/tasks/${id}/review/bounce`)
      .send({ target: 'implementation' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comment is required/i);
  });
});

describe('daemon API — abandon task', () => {
  it('abandons a task mid-flight from a gate; halts further auto-advance', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/generate-brief`).send({});
    await request(app).post(`/api/tasks/${id}/approve-brief`).send({}); // -> human_plan_approval

    const res = await request(app)
      .post(`/api/tasks/${id}/abandon`)
      .send({ comment: 'changed mind' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('abandoned');
    // Stage is unchanged — abandon is a status flip, not a stage move.
    expect(res.body.stage).toBe('human_plan_approval');

    // A gate action on an abandoned task is now illegal.
    const approve = await request(app).post(`/api/tasks/${id}/approve-plan`).send({});
    expect(approve.status).toBe(409);
  });

  it('abandons a brand-new task at intake', async () => {
    const id = await makeTask();
    const res = await request(app).post(`/api/tasks/${id}/abandon`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('abandoned');
    expect(res.body.stage).toBe('intake');
  });

  it('abandoning an already-terminal task is rejected with 409', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/abandon`).send({});
    const again = await request(app).post(`/api/tasks/${id}/abandon`).send({});
    expect(again.status).toBe(409);
  });
});

describe('daemon API — projects, artifact edits, task delete', () => {
  it('persists a project description', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main', description: 'a repo' });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe('a repo');
  });

  it('POST /api/projects/detect-commands suggests commands from package.json', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' } }),
    );
    const res = await request(app).post('/api/projects/detect-commands').send({ repoPath: dir });
    expect(res.status).toBe(200);
    expect(res.body.testCommand).toBe('npm run test');
    expect(res.body.lintCommand).toBe('npm run lint');
    // No typecheck/e2e/dev scripts -> left empty; unknown `build` ignored.
    expect(res.body.typecheckCommand).toBe('');
  });

  it('detect-commands returns empty commands for a repo without scripts', async () => {
    const res = await request(app).post('/api/projects/detect-commands').send({ repoPath: dir });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      testCommand: '',
      lintCommand: '',
      typecheckCommand: '',
      e2eCommand: '',
      devCommand: '',
    });
  });

  it('detect-commands rejects a missing or nonexistent repoPath', async () => {
    expect((await request(app).post('/api/projects/detect-commands').send({})).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/projects/detect-commands')
          .send({ repoPath: '/nope/does/not/exist' })
      ).status,
    ).toBe(400);
  });

  it('PATCH /api/artifacts/:id rewrites the body', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/generate-brief`).send({});
    const detail = await request(app).get(`/api/tasks/${id}`);
    const brief = detail.body.artifacts.find((a: { kind: string }) => a.kind === 'task_brief');

    const patched = await request(app)
      .patch(`/api/artifacts/${brief.id}`)
      .send({ body: '# Edited brief\n\nnew content' });
    expect(patched.status).toBe(200);
    expect(patched.body.body).toBe('# Edited brief\n\nnew content');

    const reread = await request(app).get(`/api/artifacts/${brief.id}`);
    expect(reread.body.body).toBe('# Edited brief\n\nnew content');
  });

  it('PATCH without a string body is rejected with 400', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/generate-brief`).send({});
    const detail = await request(app).get(`/api/tasks/${id}`);
    const brief = detail.body.artifacts.find((a: { kind: string }) => a.kind === 'task_brief');
    const res = await request(app).patch(`/api/artifacts/${brief.id}`).send({ body: 42 });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/tasks/:id removes the task and its children', async () => {
    const id = await makeTask();
    await request(app).post(`/api/tasks/${id}/generate-brief`).send({});

    const del = await request(app).delete(`/api/tasks/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const after = await request(app).get(`/api/tasks/${id}`);
    expect(after.status).toBe(404);
    expect(store.listArtifacts(id)).toHaveLength(0);
    expect(store.listStageRuns(id)).toHaveLength(0);
  });

  it('DELETE on a missing task is 404', async () => {
    const res = await request(app).delete('/api/tasks/task_does_not_exist');
    expect(res.status).toBe(404);
  });
});

describe('daemon API — self-targeting worktree guard', () => {
  const SELF_REPO = '/fake/workbench-self';
  // An app whose repoRoot equals SELF_REPO, so a project at that path is
  // self-targeting (the workbench operating on its own repo).
  let selfApp: ReturnType<typeof createApp>;
  beforeEach(() => {
    selfApp = createApp(store, { repoRoot: SELF_REPO });
  });

  it('exposes selfTargeting:true on a task whose project is the workbench repo', async () => {
    const p = await request(selfApp)
      .post('/api/projects')
      .send({ name: 'Self', repoPath: SELF_REPO, defaultBranch: 'main' });
    const t = await request(selfApp)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
    const detail = await request(selfApp).get(`/api/tasks/${t.body.id}`);
    expect(detail.body.selfTargeting).toBe(true);
  });

  it('exposes selfTargeting:false for a non-self project', async () => {
    const p = await request(selfApp)
      .post('/api/projects')
      .send({ name: 'Other', repoPath: '/some/other/repo', defaultBranch: 'main' });
    const t = await request(selfApp)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
    const detail = await request(selfApp).get(`/api/tasks/${t.body.id}`);
    expect(detail.body.selfTargeting).toBe(false);
  });

  it('rejects approve-brief with skipWorktree:true on a self-targeting project (409)', async () => {
    const p = await request(selfApp)
      .post('/api/projects')
      .send({ name: 'Self', repoPath: SELF_REPO, defaultBranch: 'main' });
    const t = await request(selfApp)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
    const id = t.body.id as string;
    await request(selfApp).post(`/api/tasks/${id}/generate-brief`).send({});

    const refused = await request(selfApp)
      .post(`/api/tasks/${id}/approve-brief`)
      .send({ skipWorktree: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toMatch(/isolated worktree/i);
  });
});

describe('daemon API — shared-secret auth gate (WORKBENCH_TOKEN)', () => {
  const prev = process.env.WORKBENCH_TOKEN;
  let authStore: Store;
  let authDir: string;
  let authApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.WORKBENCH_TOKEN = 'secret';
    authDir = mkdtempSync(join(tmpdir(), 'wb-auth-'));
    authStore = new Store({ dbPath: ':memory:', artifactsDir: authDir });
    authApp = createApp(authStore);
  });
  afterEach(() => {
    authStore.close();
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.WORKBENCH_TOKEN;
    else process.env.WORKBENCH_TOKEN = prev;
  });

  it('401s a request with no token', async () => {
    const res = await request(authApp).get('/api/tasks');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('401s a request with a wrong token', async () => {
    const res = await request(authApp).get('/api/tasks').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('accepts the token via the Authorization Bearer header', async () => {
    const res = await request(authApp).get('/api/tasks').set('Authorization', 'Bearer secret');
    expect(res.status).toBe(200);
  });

  it('accepts the token via the ?token= query param (for EventSource SSE)', async () => {
    const res = await request(authApp).get('/api/tasks?token=secret');
    expect(res.status).toBe(200);
  });

  it('exempts /api/health (liveness probe needs no auth)', async () => {
    const res = await request(authApp).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('exempts the loopback /internal/* MCP gate callback', async () => {
    // No such run exists, so this 404s — but crucially it is NOT a 401, proving
    // the auth gate let it through (the route ran).
    const res = await request(authApp).post('/internal/agent/runs/nope/ask').send({});
    expect(res.status).not.toBe(401);
  });
});

describe('daemon API — no auth gate when WORKBENCH_TOKEN is unset', () => {
  const prev = process.env.WORKBENCH_TOKEN;
  beforeEach(() => {
    delete process.env.WORKBENCH_TOKEN;
  });
  afterEach(() => {
    if (prev !== undefined) process.env.WORKBENCH_TOKEN = prev;
  });

  it('serves requests with no token (back-compat for local dev)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wb-noauth-'));
    const s = new Store({ dbPath: ':memory:', artifactsDir: d });
    const a = createApp(s);
    const res = await request(a).get('/api/tasks');
    expect(res.status).toBe(200);
    s.close();
    rmSync(d, { recursive: true, force: true });
  });
});

describe('daemon API — canonical constants stay wired to routes/inputs', () => {
  let store2: Store;
  let dir2: string;
  let app2: ReturnType<typeof createApp>;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'wb-const-'));
    store2 = new Store({ dbPath: ':memory:', artifactsDir: dir2 });
    app2 = createApp(store2);
  });
  afterEach(() => {
    store2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  const newTask = async () => {
    const p = await request(app2)
      .post('/api/projects')
      .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const t = await request(app2)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'r' });
    return t.body.id as string;
  };

  it('every LIFECYCLE_ACTIONS entry has a registered route (not a missing-route 404)', async () => {
    const id = await newTask();
    for (const action of LIFECYCLE_ACTIONS) {
      const res = await request(app2).post(`/api/tasks/${id}/${action}`).send({});
      // A registered route replies 200/400/409 depending on state; only an
      // UNregistered path 404s. So no valid action should ever 404 here.
      expect(res.status, `${action} should be a live route`).not.toBe(404);
    }
    // A bogus action is not a route -> 404 (proves the assertion above is meaningful).
    const bogus = await request(app2).post(`/api/tasks/${id}/not-an-action`).send({});
    expect(bogus.status).toBe(404);
  });

  it('accepts a valid worktreeMode and rejects an invalid one on task create', async () => {
    const p = await request(app2)
      .post('/api/projects')
      .send({ name: 'P', repoPath: '/tmp/r', defaultBranch: 'main' });
    const ok = await request(app2)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'r', worktreeMode: 'direct' });
    expect(ok.status).toBe(201);
    expect(ok.body.worktreeMode).toBe('direct');

    const bad = await request(app2)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'r', worktreeMode: 'nope' });
    expect(bad.status).toBe(400);
  });
});
