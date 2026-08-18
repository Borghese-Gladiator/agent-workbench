import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, repositories, type WorkbenchDatabase } from '../index.js';
import { upsertTask } from './tasks.js';
import {
  insertCommandExecution,
  completeCommandExecution,
  getCommandExecutionsForPhaseAttempt,
} from './command-executions.js';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';
const now = '2026-08-17T00:00:00.000Z';

describe('command-executions data access', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-cmd-exec-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    upsertTask(db.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'p' });
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('inserts an open row on spawn then closes it with ended_at + exit_code on finish', () => {
    const phaseAttemptId = `${TASK_ID}-verify-1`;
    const id = insertCommandExecution(db.db, {
      phaseAttemptId,
      runId: `${TASK_ID}-run`,
      phase: 'verify',
      command: 'pnpm test',
      cwd: '/tmp/worktree',
      startedAt: now,
    });

    // Row exists mid-flight with live timing and no exit yet.
    const open = getCommandExecutionsForPhaseAttempt(db.db, phaseAttemptId)[0];
    expect(open).toBeDefined();
    expect(open?.id).toBe(id);
    expect(open?.command).toBe('pnpm test');
    expect(open?.cwd).toBe('/tmp/worktree');
    expect(open?.startedAt).toBe(now);
    expect(open?.exitCode).toBeNull();
    expect(open?.endedAt).toBeNull();

    const endedAt = '2026-08-17T00:00:05.000Z';
    completeCommandExecution(db.db, id, { exitCode: 0, endedAt });

    const closed = getCommandExecutionsForPhaseAttempt(db.db, phaseAttemptId);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.exitCode).toBe(0);
    expect(closed[0]?.endedAt).toBe(endedAt);
  });

  it('ensures the run + phase_attempt FK parents so an insert never violates foreign_keys', () => {
    // No run/phase_attempt seeded — the helper must create them before inserting the child row.
    const phaseAttemptId = `${TASK_ID}-verify-2`;
    expect(() =>
      insertCommandExecution(db.db, {
        phaseAttemptId,
        runId: `${TASK_ID}-run`,
        phase: 'verify',
        command: 'pnpm build',
        cwd: '/tmp/worktree',
        startedAt: now,
      }),
    ).not.toThrow();
    expect(getCommandExecutionsForPhaseAttempt(db.db, phaseAttemptId)).toHaveLength(1);
  });

  it('records a non-zero exit code for a failed command', () => {
    const phaseAttemptId = `${TASK_ID}-verify-3`;
    const id = insertCommandExecution(db.db, {
      phaseAttemptId,
      runId: `${TASK_ID}-run`,
      phase: 'verify',
      command: 'pnpm lint',
      cwd: '/tmp/worktree',
      startedAt: now,
    });
    completeCommandExecution(db.db, id, { exitCode: 2, endedAt: '2026-08-17T00:00:02.000Z' });
    const rows = getCommandExecutionsForPhaseAttempt(db.db, phaseAttemptId);
    expect(rows[0]?.exitCode).toBe(2);
  });

  it('returns rows for a phase attempt oldest-started first', () => {
    const phaseAttemptId = `${TASK_ID}-verify-4`;
    insertCommandExecution(db.db, { phaseAttemptId, runId: `${TASK_ID}-run`, phase: 'verify', command: 'first', cwd: '/w', startedAt: '2026-08-17T00:00:01.000Z' });
    insertCommandExecution(db.db, { phaseAttemptId, runId: `${TASK_ID}-run`, phase: 'verify', command: 'second', cwd: '/w', startedAt: '2026-08-17T00:00:02.000Z' });
    const rows = getCommandExecutionsForPhaseAttempt(db.db, phaseAttemptId);
    expect(rows.map((r) => r.command)).toEqual(['first', 'second']);
  });
});
