#!/usr/bin/env node
/**
 * is-empty-repo — deterministic "is there any real code here?" check.
 *
 * Companion to `detect-repo-type.mjs`. Given a directory, decides whether it is a
 * brand-new / empty repo with NO actual code content — so the lifecycle can skip
 * the read-only Discovery agent run (there is nothing to explore) and go straight
 * to building.
 *
 * Deliberately a fixed DENYLIST + a shallow walk, not dynamic resolution. The repo
 * is "empty" when, after ignoring version-control, editor, and boilerplate entries
 * (`.git`, `README*`, `LICENSE*`, `.gitignore`, dotfiles, etc.), no source-bearing
 * file remains. CONSERVATIVE BY DESIGN: anything we don't recognise as boilerplate
 * counts as content, so an uncertain repo runs the normal Discovery rather than
 * skipping it.
 *
 * Usage:  node is-empty-repo.mjs [dir]      # default: cwd
 * Output: {"empty":true} on stdout, or {"empty":false}.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Top-level directory names that never count as code content. A repo whose only
 * subdirectories are these is still considered empty.
 */
const IGNORED_DIRS = new Set(['.git', '.github', '.vscode', '.idea', 'node_modules', '.husky']);

/**
 * Top-level file names (case-insensitive) that are boilerplate, not code:
 * VCS/editor metadata and the usual brand-new-repo scaffolding.
 */
const IGNORED_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.gitkeep',
  '.editorconfig',
  '.ds_store',
  'license',
  'license.md',
  'license.txt',
  'readme',
  'readme.md',
  'readme.rst',
  'readme.txt',
  'contributing.md',
  'code_of_conduct.md',
  'changelog.md',
]);

/** A file is "boilerplate" if it is in the ignore set or a bare dotfile. */
function isBoilerplateFile(name) {
  const lower = name.toLowerCase();
  if (IGNORED_FILES.has(lower)) return true;
  // Bare dotfiles at the root (e.g. `.env.example`, `.npmrc`) are config, not code.
  if (name.startsWith('.')) return true;
  return false;
}

/**
 * Walk `dir` looking for any source-bearing file. Returns true the moment one is
 * found. Skips ignored directories entirely. Bounded depth keeps it cheap and
 * avoids descending into anything pathological.
 */
function hasContent(dir, depth) {
  if (depth > 6) return true; // deep tree ⇒ clearly not empty; stop early
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (hasContent(join(dir, entry.name), depth + 1)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    // Below the top level, every file is content — boilerplate names only get a
    // pass at the root (a `README.md` inside `src/` is still real content).
    if (depth === 0 && isBoilerplateFile(entry.name)) continue;
    return true;
  }
  return false;
}

/** True when `dir` exists but contains no real code content. */
export function isEmptyRepo(dir) {
  const root = resolve(dir);
  if (!existsSync(root)) return false; // can't claim empty for a missing dir
  try {
    if (!statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  return !hasContent(root, 0);
}

// CLI entry — only when run directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? process.cwd();
  process.stdout.write(JSON.stringify({ empty: isEmptyRepo(dir) }) + '\n');
}
