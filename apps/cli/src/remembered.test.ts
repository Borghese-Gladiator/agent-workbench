import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rememberRepositoryId,
  rememberTaskId,
  resolveRepositoryId,
  resolveTaskId,
} from './remembered.js';

describe('remembered ids', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-remembered-'));
    process.env.AWB_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.AWB_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('prefers an explicit id over the remembered one', () => {
    rememberRepositoryId('remembered-repo');
    expect(resolveRepositoryId('explicit-repo')).toBe('explicit-repo');
  });

  it('falls back to the remembered id when none is given', () => {
    rememberRepositoryId('repo-1');
    rememberTaskId('task-1');
    expect(resolveRepositoryId(undefined)).toBe('repo-1');
    expect(resolveTaskId(undefined)).toBe('task-1');
  });

  it('the latest remembered id wins', () => {
    rememberRepositoryId('repo-1');
    rememberRepositoryId('repo-2');
    expect(resolveRepositoryId(undefined)).toBe('repo-2');
  });

  it('throws a clear error when nothing is given or remembered', () => {
    expect(() => resolveRepositoryId(undefined)).toThrow(/No repository id/);
    expect(() => resolveTaskId(undefined)).toThrow(/No task id/);
  });
});
