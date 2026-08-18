import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRunCommand } from '@awb/repository';
import {
  selectQaExecutor,
  type QaExecutorDescriptor,
  type ResolvedStartCommand,
} from './command-support.js';

// The comprehensive cross-ecosystem matrix lives in @awb/repository's run-command.test.ts. This file
// covers the worker's contract with it: tier-3 delegation returns a `serves`-tagged result that the
// exercise phase can gate on. (Tiers 1-2 hit SQLite and are covered by the DB integration path.)
describe('resolveRunCommand (worktree tier-3 inference, TASK-65)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-startcmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('infers a serving uvicorn command for a produced FastAPI app at app/main.py', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "lunch"\n');
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'main.py'),
      'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef root():\n    return {"ok": True}\n',
    );

    const resolved = await resolveRunCommand(dir, { requestedBaseUrl: 'http://localhost:8000' });
    expect(resolved?.serves).toBe(true);
    expect(resolved?.command).toContain('uvicorn app.main:app');
    expect(resolved?.command).toContain('--port 8000');
    expect(resolved && resolved.serves ? resolved.baseUrl : undefined).toBe('http://127.0.0.1:8000');
  });

  it('returns undefined for an unrecognized project shape', async () => {
    await writeFile(join(dir, 'README.md'), '# just docs');
    expect(await resolveRunCommand(dir)).toBeUndefined();
  });

  it('tags a compiled C project serves:false (no browser-QA target)', async () => {
    await writeFile(join(dir, 'main.c'), 'int main(void){return 0;}\n');
    const resolved = await resolveRunCommand(dir);
    expect(resolved?.serves).toBe(false);
  });
});

describe('selectQaExecutor', () => {
  const serving: ResolvedStartCommand = {
    command: 'npx vite --host 127.0.0.1 --port 5173',
    serves: true,
    baseUrl: 'http://127.0.0.1:5173',
    source: 'framework-inference',
  };
  const nonServing: ResolvedStartCommand = {
    command: 'node dist/cli.js',
    serves: false,
    source: 'language-default',
  };

  it('routes a serves:true resolution with a worktree to the browser executor', () => {
    const result = selectQaExecutor({
      qaMode: 'browser',
      resolvedStart: serving,
      hasWorktree: true,
    });
    expect(result).toEqual<QaExecutorDescriptor>({
      kind: 'browser',
      command: serving.command,
      baseUrl: serving.baseUrl,
      persistSource: serving.source,
    });
  });

  it('falls back to a non-browser (NOT exit-1) executor for a serves:false command under browser mode', () => {
    const result = selectQaExecutor({
      qaMode: 'browser',
      resolvedStart: nonServing,
      hasWorktree: true,
    });
    expect(result).toEqual<QaExecutorDescriptor>({
      kind: 'serve-as-is',
      command: nonServing.command,
    });
    // The fix: it must NOT be the old echo/exit-1 CLI hard-fail path.
    expect(result.kind).not.toBe('cli-ok');
  });

  it('falls back to a defined library consumer (NOT exit-1) when nothing resolved under browser mode', () => {
    const result = selectQaExecutor({
      qaMode: 'browser',
      resolvedStart: undefined,
      hasWorktree: true,
    });
    expect(result.kind).toBe('library');
    expect(result.kind).not.toBe('cli-ok');
    expect(result).toEqual<QaExecutorDescriptor>({
      kind: 'library',
      consumerScriptSource: 'console.log("ASSERT:library-importable=true");',
    });
  });

  it('honors an explicit library script source under browser fallback', () => {
    const result = selectQaExecutor({
      qaMode: 'browser',
      resolvedStart: undefined,
      hasWorktree: true,
      libraryScriptSource: 'console.log("ASSERT:x=true");',
    });
    expect(result).toEqual<QaExecutorDescriptor>({
      kind: 'library',
      consumerScriptSource: 'console.log("ASSERT:x=true");',
    });
  });

  it.each([
    {
      name: 'explicit http-api mode passes through with default base url',
      input: { qaMode: 'http-api', resolvedStart: undefined, hasWorktree: false },
      expected: { kind: 'http-api', baseUrl: 'http://localhost:3000' },
    },
    {
      name: 'explicit http-api mode honors provided base url',
      input: {
        qaMode: 'http-api',
        resolvedStart: undefined,
        hasWorktree: false,
        httpApiBaseUrl: 'http://localhost:9000',
      },
      expected: { kind: 'http-api', baseUrl: 'http://localhost:9000' },
    },
    {
      name: 'explicit library mode passes through',
      input: { qaMode: 'library', resolvedStart: undefined, hasWorktree: false },
      expected: {
        kind: 'library',
        consumerScriptSource: 'console.log("ASSERT:library-importable=true");',
      },
    },
    {
      name: 'no qaMode (mock/default) selects cli-ok',
      input: { qaMode: undefined, resolvedStart: undefined, hasWorktree: false },
      expected: { kind: 'cli-ok' },
    },
    {
      name: 'serves:true but no worktree does NOT browser-QA (falls to cli-ok when no mode)',
      input: { qaMode: undefined, resolvedStart: serving, hasWorktree: false },
      expected: { kind: 'cli-ok' },
    },
  ])('$name', ({ input, expected }) => {
    expect(selectQaExecutor(input)).toEqual(expected as QaExecutorDescriptor);
  });
});
