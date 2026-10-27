import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@workbench/store';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-val-daemon-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Drive a task to the validation stage with the given project commands. */
async function driveToValidation(commands: Record<string, string>) {
  const app = createApp(store); // real CommandValidationRunner
  // repoPath must exist: with the stub worktree, validation runs in this cwd.
  const repoPath = mkdtempSync(join(tmpdir(), 'wb-val-repo-'));
  const p = await request(app)
    .post('/api/projects')
    .send({ name: 'P', repoPath, defaultBranch: 'main', ...commands });
  const t = await request(app)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'T', rawRequest: 'do a thing' });
  const id = t.body.id as string;
  await request(app).post(`/api/tasks/${id}/generate-brief`).send({});
  await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
  // approve-plan auto-advances through implementation -> validation.
  const afterPlan = await request(app).post(`/api/tasks/${id}/approve-plan`).send({});
  return { app, id, afterPlan: afterPlan.body };
}

// Real-git + real-subprocess integration: these drive shell validation commands
// and a git worktree, so they legitimately run longer than a unit test and must
// not race vitest's 5s default under parallel-worker CPU pressure. 30s headroom.
describe('real validation in the lifecycle', { timeout: 30_000 }, () => {
  it('records the real failed status and treats it as pre-existing (baseline runs the same cwd)', async () => {
    // `exit 1` fails post-change AND in the baseline (the stub worktree resolves
    // verification to repoPath, the same cwd the baseline runs in), so the
    // failure is pre-existing -> the task advances rather than parking. The real
    // CommandValidationRunner still captures the genuine `failed` status. The
    // park-on-NEW-failure path (base green, worktree red) is unit-tested in
    // lifecycle-stages.test.ts "Verification baseline comparison".
    const { app, id, afterPlan } = await driveToValidation({ testCommand: 'exit 1' });

    expect(afterPlan.stage).toBe('human_review');

    const detail = await request(app).get(`/api/tasks/${id}`);
    const kinds = detail.body.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toContain('validation_report');
    // The baseline was captured to adjudicate the failure.
    expect(kinds).toContain('baseline_evidence');

    const failed = detail.body.validationRuns.find(
      (r: { command: string }) => r.command === 'exit 1',
    );
    expect(failed.status).toBe('failed');
  });

  it('auto-advances to human_review when all commands pass', async () => {
    const { afterPlan } = await driveToValidation({
      testCommand: 'exit 0',
      typecheckCommand: 'true',
    });
    expect(afterPlan.stage).toBe('human_review');
  });

  it('treats empty commands as skipped and still advances', async () => {
    const { afterPlan } = await driveToValidation({});
    expect(afterPlan.stage).toBe('human_review');
  });
});
