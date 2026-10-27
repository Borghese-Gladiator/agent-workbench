import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedStartCommand } from './command-support.js';

/**
 * The QA executor `exercise` will actually run, and what it needs to run it (TASK-73).
 *
 * Before this, QA mode came PURELY from `AWB_QA_MODE`, and browser QA with no `serves: true` command
 * hit a deliberate `exit 1` hard-fail — so a finished, verified change on a truly static frontend
 * dead-ended. Nothing routed a `serves: false` result anywhere either: `run-command.ts` and
 * `command-support.ts` both captured one "for a future consumer" that was never written.
 *
 * This is that consumer. A missing dev server now degrades to a defined QA mode instead of failing.
 */
export type QaModeSelection =
  /** A real dev server exists: drive it with Chromium. */
  | { mode: 'browser'; command: string; baseUrl: string }
  /**
   * The project resolved to a one-shot run / CLI / compiled binary (`serves: false`). Run THAT
   * command and assert it exits cleanly — "serve as is" for a project that does not serve.
   */
  | { mode: 'cli-run'; command: string }
  /** Scripted HTTP against an API the repo shape says is there. */
  | { mode: 'http-api' }
  /** A consumer script importing the built library. */
  | { mode: 'library' }
  /** Nothing about the repo is recognizable; the generic CLI executor runs. */
  | { mode: 'cli-default' };

/** What the worktree looks like, for the fallback decision. Read once, off disk, by the caller. */
export interface RepoShape {
  /** The project declares a web/HTTP server dependency (express, fastify, flask, django, …). */
  servesHttp: boolean;
  /** The project declares a consumable entry point (`main`/`module`/`exports`) — i.e. a library. */
  isLibrary: boolean;
}

/**
 * Picks the QA executor. Pure: every input is already resolved, so the whole decision table is
 * unit-testable without a worktree, a server, or a browser.
 *
 * An explicit `http-api` or `library` request always wins — the operator said what they wanted. The
 * interesting case is `browser`, which is a REQUEST, not a guarantee: it is honored only when a
 * `serves: true` command resolved, and otherwise degrades in order of how much the fallback actually
 * exercises: the project's own run command, then an HTTP API, then a library import, then the
 * generic CLI executor. No branch fails the phase.
 */
export function selectQaMode(input: {
  requestedMode: string | undefined;
  resolved: ResolvedStartCommand | undefined;
  repoShape: RepoShape;
  /** An operator-supplied base URL overrides the resolver's, as it always has. */
  requestedBaseUrl?: string;
}): QaModeSelection {
  const { requestedMode, resolved, repoShape } = input;

  if (requestedMode === 'http-api') return { mode: 'http-api' };
  if (requestedMode === 'library') return { mode: 'library' };

  if (resolved?.serves === true) {
    return {
      mode: 'browser',
      command: resolved.command,
      baseUrl: input.requestedBaseUrl ?? resolved.baseUrl,
    };
  }

  // Browser QA was requested but nothing serves. Degrade rather than dead-end.
  if (requestedMode === 'browser') {
    if (resolved?.serves === false) return { mode: 'cli-run', command: resolved.command };
    if (repoShape.servesHttp) return { mode: 'http-api' };
    if (repoShape.isLibrary) return { mode: 'library' };
  }

  return { mode: 'cli-default' };
}

/** Dependency names that mean "this project serves HTTP", across the ecosystems we resolve run commands for. */
const HTTP_SERVER_DEPENDENCIES = [
  'express',
  'fastify',
  'koa',
  '@nestjs/core',
  'hapi',
  '@hapi/hapi',
  'next',
  'flask',
  'django',
  'fastapi',
  'starlette',
  'uvicorn',
  'gunicorn',
];

/**
 * Reads the worktree to decide what shape the project is. Best-effort by design: an unreadable or
 * absent manifest yields "neither", which routes to the generic CLI executor rather than failing.
 */
export async function detectRepoShape(worktreePath: string): Promise<RepoShape> {
  const shape: RepoShape = { servesHttp: false, isLibrary: false };

  const packageJson = await readJson(join(worktreePath, 'package.json'));
  if (packageJson) {
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    shape.servesHttp = HTTP_SERVER_DEPENDENCIES.some((name) => name in dependencies);
    // `private: true` marks an app or a workspace root, not something anyone imports.
    shape.isLibrary =
      packageJson.private !== true &&
      Boolean(packageJson.main ?? packageJson.module ?? packageJson.exports ?? packageJson.types);
  }

  // A Python project declares its server dependency in pyproject.toml rather than package.json.
  if (!shape.servesHttp) {
    const pyproject = await readText(join(worktreePath, 'pyproject.toml'));
    if (pyproject) {
      const lowered = pyproject.toLowerCase();
      shape.servesHttp = HTTP_SERVER_DEPENDENCIES.some((name) => lowered.includes(`"${name}`) || lowered.includes(`'${name}`));
      if (!shape.isLibrary) shape.isLibrary = lowered.includes('[project]');
    }
  }

  return shape;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
  types?: string;
  private?: boolean;
}

async function readJson(path: string): Promise<PackageManifest | undefined> {
  const text = await readText(path);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as PackageManifest;
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
