#!/usr/bin/env node
/**
 * detect-repo-type — deterministic repo fingerprinter (the review/QA "router").
 *
 * Given a worktree path, decides which review skill profile applies by checking a
 * small, fixed set of file/dependency signals. Deliberately a MAP LOOKUP over
 * signals, not dynamic resolution — add a row to `PROFILES` to support a new repo
 * type.
 *
 * Usage:  node detect-repo-type.mjs [dir]      # default: cwd
 * Output: {"profile":"ts-shadcn-frontend"} on stdout, or {"profile":null}.
 *
 * Profiles are checked top-to-bottom; the FIRST match wins, so order from most
 * specific to least.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Read+parse a JSON file, or null if absent/unparseable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Does any dependency map in package.json contain `name`? */
function hasDep(pkg, name) {
  if (!pkg) return false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[field] && Object.hasOwn(pkg[field], name)) return true;
  }
  return false;
}

/** Does pyproject.toml mention `name` (cheap substring check, no TOML parser)? */
function pyprojectMentions(dir, name) {
  const p = join(dir, 'pyproject.toml');
  if (!existsSync(p)) return false;
  try {
    return readFileSync(p, 'utf8').toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Profile table. Each `match(dir, ctx)` returns true if the profile applies.
 * `ctx` carries pre-read values so each profile doesn't re-read package.json.
 */
const PROFILES = [
  {
    // Klaviyo app: Django monorepo. CONTENT-based match (manage.py + the
    // distinctive src/learning layout), NOT path-based — a per-task git worktree
    // of the repo lives under the workbench's data/worktrees/<project>/<task>
    // and must still route to the app skills (a path check silently disabled
    // skill injection + compliance for exactly the runs they were built for).
    profile: 'app',
    match: (dir) =>
      existsSync(join(dir, 'manage.py')) && existsSync(join(dir, 'src', 'learning')),
  },
  {
    // Klaviyo fender: turbo monorepo of @klaviyo/* packages
    profile: 'fender',
    match: (dir, { pkg }) =>
      (dir.split(sep).includes('fender') && dir.includes(`Klaviyo${sep}Repos`)) ||
      (existsSync(join(dir, 'turbo.json')) &&
        Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).some((d) =>
          d.startsWith('@klaviyo/'),
        )),
  },
  {
    // Generic TS + shadcn/ui + Tailwind frontend
    profile: 'ts-shadcn-frontend',
    match: (dir, { pkg }) =>
      existsSync(join(dir, 'components.json')) || // shadcn marker
      hasDep(pkg, 'tailwindcss') ||
      existsSync(join(dir, 'tailwind.config.ts')) ||
      existsSync(join(dir, 'tailwind.config.js')),
  },
  {
    // Python FastAPI backend
    profile: 'py-fastapi-backend',
    match: (dir) => pyprojectMentions(dir, 'fastapi') || pyprojectMentions(dir, 'uvicorn'),
  },
];

export function detectRepoType(dir) {
  const root = resolve(dir);
  const pkg = readJson(join(root, 'package.json'));
  const ctx = { pkg };
  for (const { profile, match } of PROFILES) {
    if (match(root, ctx)) return profile;
  }
  return null;
}

// CLI entry — only when run directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? process.cwd();
  process.stdout.write(JSON.stringify({ profile: detectRepoType(dir) }) + '\n');
}
