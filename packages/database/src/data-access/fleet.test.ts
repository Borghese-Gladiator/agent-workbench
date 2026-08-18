import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, repositories, semanticEvents, findings, pullRequests, type WorkbenchDatabase } from '../index.js';
import { upsertTask, ensureRun, ensurePhaseAttempt } from './tasks.js';
import { getFleetStatus } from './fleet.js';

const REPO_ID = 'repo-1';
const now = new Date('2026-08-18T00:00:00.000Z');

function iso(offsetSec: number): string {
  return new Date(now.getTime() + offsetSec * 1000).toISOString();
}

describe('getFleetStatus', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-fleet-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'games', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: iso(0), updatedAt: iso(0) })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('composes phase/activity/findings/PR for a task in one call', () => {
    const d = db.db;
    upsertTask(d, { id: 'task-A', repositoryId: REPO_ID, prompt: 'Implement President\nsecond line', phase: 'implement', condition: 'running', size: 'M' });
    const runId = ensureRun(d, 'task-A');
    const attempt = ensurePhaseAttempt(d, { taskId: 'task-A', phase: 'implement', attemptNumber: 1 });
    d.insert(semanticEvents)
      .values({ id: 'ev-1', runId, sequence: 1, occurredAt: iso(-30), phase: 'implement', phaseAttemptId: attempt, producer: 'builder', type: 'message', summary: 'first' })
      .run();
    d.insert(semanticEvents)
      .values({ id: 'ev-2', runId, sequence: 2, occurredAt: iso(-10), phase: 'implement', phaseAttemptId: attempt, producer: 'builder', type: 'tool', summary: 'writing engine tests' })
      .run();
    d.insert(findings)
      .values({ id: 'f-1', taskId: 'task-A', severity: 'high', category: 'correctness', claimIdsJson: '[]', description: 'missing pass handling', status: 'open' })
      .run();
    d.insert(pullRequests)
      .values({ id: 'pr-1', taskId: 'task-A', number: 42, url: 'http://x/42', state: 'open', isDraft: true, title: 't', createdAt: iso(-5), updatedAt: iso(-5) })
      .run();

    const row = getFleetStatus(d, now)[0]!;
    expect(row.taskId).toBe('task-A');
    expect(row.repositoryName).toBe('games');
    expect(row.promptLine).toBe('Implement President');
    expect(row.phase).toBe('implement');
    expect(row.size).toBe('M');
    expect(row.attempt).toBe(1);
    expect(row.bouncedFrom).toBeNull();
    // Latest event by sequence wins.
    expect(row.activity).toBe('writing engine tests');
    expect(row.activityAgeSec).toBe(10);
    expect(row.openFindings).toBe(1);
    expect(row.topFinding).toEqual({ severity: 'high', description: 'missing pass handling' });
    expect(row.pr).toEqual({ number: 42, url: 'http://x/42', isDraft: true, state: 'open' });
  });

  it('detects a bounce back to an earlier phase from phase_attempts', () => {
    const d = db.db;
    // Reached verify, then regressed to implement (attempt 2).
    upsertTask(d, { id: 'task-B', repositoryId: REPO_ID, prompt: 'p', phase: 'implement', condition: 'running' });
    ensureRun(d, 'task-B');
    ensurePhaseAttempt(d, { taskId: 'task-B', phase: 'implement', attemptNumber: 1 });
    ensurePhaseAttempt(d, { taskId: 'task-B', phase: 'verify', attemptNumber: 1 });
    const back = ensurePhaseAttempt(d, { taskId: 'task-B', phase: 'implement', attemptNumber: 2 });
    // Give the regressed attempt an outcome so lastOutcome surfaces.
    db.sqlite.prepare('UPDATE phase_attempts SET outcome = ? WHERE id = ?').run('rejected by verify', back);

    const row = getFleetStatus(d, now)[0]!;
    expect(row.phase).toBe('implement');
    expect(row.attempt).toBe(2);
    expect(row.bouncedFrom).toBe('verify');
    expect(row.lastOutcome).toBe('rejected by verify');
  });

  it('is null-safe with no events, findings, or PR', () => {
    const d = db.db;
    upsertTask(d, { id: 'task-C', repositoryId: REPO_ID, prompt: 'x', phase: 'specify', condition: 'running' });

    const row = getFleetStatus(d, now)[0]!;
    expect(row.attempt).toBe(1);
    expect(row.activity).toBeNull();
    expect(row.activityAgeSec).toBeNull();
    expect(row.openFindings).toBe(0);
    expect(row.topFinding).toBeNull();
    expect(row.pr).toBeNull();
  });

  it('returns every task, newest-updated first', () => {
    const d = db.db;
    upsertTask(d, { id: 'old', repositoryId: REPO_ID, prompt: 'a', phase: 'specify', condition: 'running' });
    upsertTask(d, { id: 'new', repositoryId: REPO_ID, prompt: 'b', phase: 'specify', condition: 'running' });
    // Force distinct updatedAt ordering.
    db.sqlite.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(iso(-100), 'old');
    db.sqlite.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(iso(0), 'new');

    const rows = getFleetStatus(d, now);
    expect(rows.map((r) => r.taskId)).toEqual(['new', 'old']);
  });
});
