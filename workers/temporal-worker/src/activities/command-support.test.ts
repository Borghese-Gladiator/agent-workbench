import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inferStartCommandFromWorktree } from './command-support.js';

describe('inferStartCommandFromWorktree (TASK-65)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-startcmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('infers a uvicorn command for a produced FastAPI app at app/main.py', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "lunch"\n');
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(
      join(dir, 'app', 'main.py'),
      'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef root():\n    return {"ok": True}\n',
    );

    const resolved = await inferStartCommandFromWorktree(dir, 'http://localhost:8000');
    expect(resolved?.source).toBe('framework-inference');
    expect(resolved?.command).toContain('uvicorn app.main:app');
    expect(resolved?.command).toContain('--port 8000');
    expect(resolved?.baseUrl).toBe('http://127.0.0.1:8000');
  });

  it('matches the port from the requested base URL for a FastAPI app', async () => {
    await writeFile(join(dir, 'requirements.txt'), 'fastapi\nuvicorn\n');
    await writeFile(join(dir, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');

    const resolved = await inferStartCommandFromWorktree(dir, 'http://localhost:9100');
    expect(resolved?.command).toContain('uvicorn main:app');
    expect(resolved?.command).toContain('--port 9100');
    expect(resolved?.baseUrl).toBe('http://127.0.0.1:9100');
  });

  it('infers a vite dev command for a produced Vite app (index.html + package.json)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'ui', devDependencies: { vite: '^5' } }),
    );
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');

    const resolved = await inferStartCommandFromWorktree(dir, 'http://localhost:5173');
    expect(resolved?.source).toBe('framework-inference');
    expect(resolved?.command).toContain('dev');
    expect(resolved?.command).toContain('--port 5173');
    expect(resolved?.baseUrl).toBe('http://127.0.0.1:5173');
  });

  it('honors the package manager for the vite dev runner', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'ui', packageManager: 'pnpm@9.0.0', dependencies: { vite: '^5' } }),
    );

    const resolved = await inferStartCommandFromWorktree(dir);
    expect(resolved?.command.startsWith('pnpm dev')).toBe(true);
  });

  it('returns undefined for an unrecognized project shape', async () => {
    await writeFile(join(dir, 'README.md'), '# just docs');
    expect(await inferStartCommandFromWorktree(dir)).toBeUndefined();
  });

  it('does not infer FastAPI when the FastAPI app instance is absent', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "cli"\n');
    await writeFile(join(dir, 'main.py'), 'def main():\n    print("hi")\n');
    expect(await inferStartCommandFromWorktree(dir)).toBeUndefined();
  });
});
