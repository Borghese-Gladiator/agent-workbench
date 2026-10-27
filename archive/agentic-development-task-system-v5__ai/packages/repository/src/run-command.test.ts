import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRunCommand } from './run-command.js';

async function scaffold(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
}

describe('resolveRunCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-runcmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('layer 0 — known-repo overrides win first', () => {
    it('fender (root package.json named "fender" + dev script) resolves to `yarn dev`, serving', async () => {
      await scaffold(dir, {
        'package.json': JSON.stringify({
          name: 'fender',
          scripts: { dev: 'NODE_OPTIONS=--max-old-space-size=8192 yarn workspace @klaviyo/scripts run yarn-dev-prompt' },
        }),
      });
      const r = await resolveRunCommand(dir);
      expect(r?.source).toBe('known-repo');
      expect(r?.command).toBe('yarn dev');
      expect(r?.serves).toBe(true);
    });

    it('app (Makefile run-server → bin/django runserver) resolves to `make run-server` on :8080', async () => {
      await scaffold(dir, {
        // app has a root package.json with no `name`; the override must key on the Makefile markers.
        'package.json': JSON.stringify({ private: true }),
        Makefile: 'run-server: PORT ?= 8080\nrun-server:\n\tbin/django runserver 0.0.0.0:${PORT} --skip-checks\n',
      });
      const r = await resolveRunCommand(dir);
      expect(r?.source).toBe('known-repo');
      expect(r?.command).toBe('make run-server');
      expect(r && r.serves ? r.baseUrl : undefined).toBe('http://127.0.0.1:8080');
    });

    it('does NOT misclassify an unrelated run-server Make target as app', async () => {
      await scaffold(dir, {
        Makefile: 'run-server:\n\t./my-custom-daemon --port 9999\n',
      });
      const r = await resolveRunCommand(dir);
      expect(r?.source).not.toBe('known-repo');
    });
  });

  describe('layer 1 — explicit run declarations win first', () => {
    it('Procfile web: process is a serving command', async () => {
      await scaffold(dir, {
        Procfile: 'web: uvicorn app.main:app --port 8000\nworker: celery -A app worker\n',
        'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      });
      const r = await resolveRunCommand(dir);
      expect(r?.source).toBe('procfile');
      expect(r?.serves).toBe(true);
      expect(r?.command).toContain('uvicorn');
    });

    it('docker-compose published port makes the service a server with that port', async () => {
      await scaffold(dir, {
        'docker-compose.yml': 'services:\n  api:\n    command: python -m http.server\n    ports:\n      - "9000:9000"\n',
      });
      const r = await resolveRunCommand(dir);
      expect(r?.source).toBe('docker-compose');
      expect(r && r.serves ? r.baseUrl : undefined).toBe('http://127.0.0.1:9000');
    });

    it('Makefile dev target resolves to `make dev`', async () => {
      await scaffold(dir, { Makefile: 'build:\n\ttsc\ndev:\n\tvite\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toBe('make dev');
      expect(r?.source).toBe('make-target');
    });
  });

  describe('layer 2 — Node', () => {
    it('prefers the written dev script and treats a vite app as serving', async () => {
      await scaffold(dir, {
        'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toBe('pnpm dev');
      expect(r?.serves).toBe(true);
      expect(r?.source).toBe('package-script');
    });

    it('infers next dev when only the dependency is present', async () => {
      await scaffold(dir, { 'package.json': JSON.stringify({ dependencies: { next: '^14' } }) });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toContain('next');
      expect(r?.serves).toBe(true);
    });
  });

  describe('layer 2 — Python frameworks', () => {
    it('Django manage.py → runserver', async () => {
      await scaffold(dir, { 'manage.py': "#!/usr/bin/env python\n", 'requirements.txt': 'django\n' });
      const r = await resolveRunCommand(dir, { requestedBaseUrl: 'http://localhost:8001' });
      expect(r?.command).toContain('manage.py runserver');
      expect(r && r.serves ? r.baseUrl : undefined).toBe('http://127.0.0.1:8001');
    });

    it('FastAPI → uvicorn', async () => {
      await scaffold(dir, { 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toContain('uvicorn main:app');
    });

    it('Flask → flask run', async () => {
      await scaffold(dir, { 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toContain('flask --app app run');
    });

    it('pyproject [project.scripts] non-server entry is serves:false', async () => {
      await scaffold(dir, { 'pyproject.toml': '[project]\nname = "cli"\n\n[project.scripts]\nrun = "cli:main"\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.serves).toBe(false);
      expect(r?.source).toBe('pyproject-script');
    });
  });

  describe('layer 2 — JVM', () => {
    it('Spring Boot gradle → bootRun (serving)', async () => {
      await scaffold(dir, { 'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n" });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toContain('bootRun');
      expect(r?.serves).toBe(true);
    });

    it('Spring Boot maven with wrapper → ./mvnw spring-boot:run', async () => {
      await scaffold(dir, { 'pom.xml': '<project><dependencies>spring-boot-starter-web</dependencies></project>\n', mvnw: '#!/bin/sh\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toBe('./mvnw spring-boot:run');
    });

    it('plain gradle project (no Spring) is serves:false', async () => {
      await scaffold(dir, { 'build.gradle': "apply plugin: 'application'\n" });
      const r = await resolveRunCommand(dir);
      expect(r?.serves).toBe(false);
    });
  });

  describe('layer 2 — Go', () => {
    it('net/http server → go run . (serving)', async () => {
      await scaffold(dir, { 'go.mod': 'module x\n', 'main.go': 'package main\nimport "net/http"\nfunc main(){ http.ListenAndServe(":8080", nil) }\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.command).toBe('go run .');
      expect(r?.serves).toBe(true);
    });

    it('Go CLI (no server) → go run . (serves:false)', async () => {
      await scaffold(dir, { 'go.mod': 'module x\n', 'main.go': 'package main\nimport "fmt"\nfunc main(){ fmt.Println("hi") }\n' });
      const r = await resolveRunCommand(dir);
      expect(r?.serves).toBe(false);
    });
  });

  describe('layer 2 — C/C++ (never a browser-QA target)', () => {
    it('C project with a Makefile is serves:false', async () => {
      await scaffold(dir, { 'main.c': 'int main(void){return 0;}\n', Makefile: 'all:\n\tcc main.c\n' });
      const r = await resolveRunCommand(dir);
      // Makefile has no run/dev/serve target here, so it falls through to the C matcher.
      expect(r?.serves).toBe(false);
    });
  });

  it('returns undefined for an unrecognized shape', async () => {
    await scaffold(dir, { 'README.md': '# docs only\n' });
    expect(await resolveRunCommand(dir)).toBeUndefined();
  });
});
