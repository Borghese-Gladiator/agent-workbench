import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRunCommand } from '@awb/repository';

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
