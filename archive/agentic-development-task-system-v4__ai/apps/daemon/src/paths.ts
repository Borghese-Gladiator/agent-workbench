import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The repo this daemon process itself runs from (apps/daemon/src -> ../../..).
 * Used to detect a self-targeting project: when a project's repoPath is this
 * very checkout, committing directly to it would let an agent edit the code/DB
 * driving the run, so the direct (skip-worktree) path is refused for it.
 */
export const REPO_ROOT = resolve(here, '../../..');
/**
 * Repo root data dir: <repo>/data (apps/daemon/src -> ../../../data). Overridable
 * via WORKBENCH_DATA_DIR so a throwaway dir can be used (tests, manual runs).
 */
export const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? resolve(process.env.WORKBENCH_DATA_DIR)
  : resolve(here, '../../../data');
export const DB_PATH = resolve(DATA_DIR, 'workbench.sqlite');
export const ARTIFACTS_DIR = resolve(DATA_DIR, 'artifacts');
/** Per-project memory logs (`<projectId>.md`); gitignored under data/. */
export const PROJECT_MEMORY_DIR = resolve(DATA_DIR, 'project-memory');
export const WORKTREES_DIR = resolve(DATA_DIR, 'worktrees');
/** Daily structured log files live here (gitignored under data/). */
export const LOGS_DIR = resolve(DATA_DIR, 'logs');

export const PORT = Number(process.env.WORKBENCH_PORT ?? 4417);
