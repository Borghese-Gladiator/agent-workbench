import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    // trimEnd only: some porcelain formats (e.g. `status --porcelain`) use a leading space as a
    // meaningful status-code column, so leading whitespace must never be stripped here.
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${err.stderr ?? err.message}`,
    );
  }
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export async function getRemotes(cwd: string): Promise<GitRemote[]> {
  const { stdout } = await runGit(cwd, ['remote', '-v']);
  if (!stdout) return [];
  const byName = new Map<string, GitRemote>();
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1] as string;
    const url = match[2] as string;
    const kind = match[3] as 'fetch' | 'push';
    const existing = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') existing.fetchUrl = url;
    else existing.pushUrl = url;
    byName.set(name, existing);
  }
  return [...byName.values()];
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (stdout) return stdout.replace(/^origin\//, '');
  } catch {
    // no remote HEAD configured; fall through to local heuristics
  }
  try {
    const { stdout } = await runGit(cwd, ['branch', '--show-current']);
    if (stdout) return stdout;
  } catch {
    // detached HEAD or no commits yet
  }
  for (const candidate of ['main', 'master']) {
    try {
      await runGit(cwd, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      continue;
    }
  }
  return 'main';
}

export async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', 'HEAD']);
  return stdout;
}

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export async function getStatus(cwd: string): Promise<GitStatusEntry[]> {
  const { stdout } = await runGit(cwd, ['status', '--porcelain=v1']);
  if (!stdout) return [];
  return stdout.split('\n').map((line) => ({
    indexStatus: line[0] ?? ' ',
    worktreeStatus: line[1] ?? ' ',
    path: line.slice(3),
  }));
}

export interface GitLogEntry {
  sha: string;
  authorDate: string;
  subject: string;
}

export async function getRecentHistory(cwd: string, limit = 20): Promise<GitLogEntry[]> {
  const { stdout } = await runGit(cwd, [
    'log',
    `-${limit}`,
    '--pretty=format:%H%x1f%aI%x1f%s',
  ]);
  if (!stdout) return [];
  return stdout.split('\n').map((line) => {
    const [sha, authorDate, subject] = line.split('\x1f') as [string, string, string];
    return { sha, authorDate, subject };
  });
}

/** Returns paths changed between two revisions (e.g. a previously-indexed SHA and current HEAD). */
export async function getChangedPaths(cwd: string, fromSha: string, toSha: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ['diff', '--name-only', `${fromSha}..${toSha}`]);
  if (!stdout) return [];
  return stdout.split('\n').filter(Boolean);
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    return stdout === 'true';
  } catch {
    return false;
  }
}
