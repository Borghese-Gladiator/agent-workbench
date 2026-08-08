import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveDataDir(): string {
  return process.env.AWB_DATA_DIR ?? join(homedir(), '.agentic-workbench');
}

export interface DataDirLayout {
  root: string;
  configFile: string;
  temporalDir: string;
  temporalSqlite: string;
  databaseDir: string;
  workbenchSqlite: string;
  artifactsDir: string;
  cacheDir: string;
  cacheRepositoriesDir: string;
  cacheVideoDir: string;
  cacheTemporaryContextDir: string;
  repositoriesDir: string;
  worktreesDir: string;
  runtimeDir: string;
  runtimePortsDir: string;
  runtimePidsDir: string;
  runtimeSocketsDir: string;
}

export function resolveLayout(root: string = resolveDataDir()): DataDirLayout {
  return {
    root,
    configFile: join(root, 'config.yaml'),
    temporalDir: join(root, 'temporal'),
    temporalSqlite: join(root, 'temporal', 'temporal.sqlite'),
    databaseDir: join(root, 'database'),
    workbenchSqlite: join(root, 'database', 'workbench.sqlite'),
    artifactsDir: join(root, 'artifacts'),
    cacheDir: join(root, 'cache'),
    cacheRepositoriesDir: join(root, 'cache', 'repositories'),
    cacheVideoDir: join(root, 'cache', 'video'),
    cacheTemporaryContextDir: join(root, 'cache', 'temporary-context'),
    repositoriesDir: join(root, 'repositories'),
    worktreesDir: join(root, 'worktrees'),
    runtimeDir: join(root, 'runtime'),
    runtimePortsDir: join(root, 'runtime', 'ports'),
    runtimePidsDir: join(root, 'runtime', 'pids'),
    runtimeSocketsDir: join(root, 'runtime', 'sockets'),
  };
}

export function repositorySnapshotsDir(layout: DataDirLayout, repositoryId: string): string {
  return join(layout.repositoriesDir, repositoryId, 'snapshots');
}

export function repositoryMapsDir(layout: DataDirLayout, repositoryId: string): string {
  return join(layout.repositoriesDir, repositoryId, 'maps');
}

/** Per-repo project-memory file projection (TASK-50): a human/skill-readable md mirror of repository_facts. */
export function repositoryMemoryDir(layout: DataDirLayout, repositoryId: string): string {
  return join(layout.repositoriesDir, repositoryId, 'memory');
}

export function worktreeDir(layout: DataDirLayout, repositoryId: string, taskId: string): string {
  return join(layout.worktreesDir, repositoryId, taskId);
}
