import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliEntry = join(__dirname, '..', 'dist', 'index.js');

async function makeFixtureRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'awb-fixture-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'echo test', start: 'node server.js' } }),
  );
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function runCli(args: string[], dataDir: string): string {
  return execFileSync('node', [cliEntry, ...args], {
    env: { ...process.env, AWB_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

/** Runs the CLI and returns combined stdout/stderr + exit code, without throwing on non-zero. */
function runCliCapture(args: string[], dataDir: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [cliEntry, ...args], {
      env: { ...process.env, AWB_DATA_DIR: dataDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('awb repo CLI', () => {
  let dataDir: string;
  let fixtureRepo: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-cli-repo-data-'));
    fixtureRepo = await makeFixtureRepo();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
  });

  it('drives add -> sync -> approve -> list -> show -> remove end to end', () => {
    // `add` prints the id as its primary result (first line), then informational lines.
    const addOutput = runCli(['repo', 'add', fixtureRepo], dataDir);
    expect(addOutput).toContain('Registered');
    expect(existsSync(join(dataDir, 'database', 'workbench.sqlite'))).toBe(true);

    const repositoryId = addOutput.split('\n')[0]?.trim();
    expect(repositoryId).toBeTruthy();

    const listOutput = runCli(['repo', 'list'], dataDir);
    expect(listOutput).toContain('[untrusted]');
    expect(listOutput).toContain(repositoryId as string);

    // `sync` is canonical; `refresh` is the retained alias — exercise the canonical name here.
    const syncOutput = runCli(['repo', 'sync', repositoryId as string], dataDir);
    expect(syncOutput).toContain('Recorded snapshot');

    const approveOutput = runCli(['repo', 'approve', repositoryId as string], dataDir);
    expect(approveOutput).toContain('is now trusted');

    const listAfterApprove = runCli(['repo', 'list', '--json'], dataDir);
    const parsed = JSON.parse(listAfterApprove) as { id: string; trusted: boolean }[];
    expect(parsed.find((r) => r.id === repositoryId)?.trusted).toBe(true);

    const showOutput = runCli(['repo', 'show', repositoryId as string], dataDir);
    const shown = JSON.parse(showOutput) as { repository: { trusted: boolean }; latestSnapshot: { headSha: string } };
    expect(shown.repository.trusted).toBe(true);
    expect(shown.latestSnapshot.headSha).toHaveLength(40);

    const removeOutput = runCli(['repo', 'remove', repositoryId as string, '--yes'], dataDir);
    expect(removeOutput).toContain('Unregistered');
    const listAfterRemove = runCli(['repo', 'list', '--json'], dataDir);
    expect(JSON.parse(listAfterRemove)).toHaveLength(0);
  });

  it('inspect is retained as an alias of show', () => {
    const addOutput = runCli(['repo', 'add', fixtureRepo], dataDir);
    const repositoryId = addOutput.split('\n')[0]?.trim();
    const inspectOutput = runCli(['repo', 'inspect', repositoryId as string], dataDir);
    const inspected = JSON.parse(inspectOutput) as { repository: { id: string } };
    expect(inspected.repository.id).toBe(repositoryId);
  });

  it('reports a clear error for an unregistered repository id', () => {
    expect(() => runCli(['repo', 'show', 'not-a-real-id'], dataDir)).toThrow();
  });

  // Autonomy pivot (TASK-104): repo trust is a one-time config flag.
  it('add --trust registers the repository already trusted', () => {
    const addOutput = runCli(['repo', 'add', fixtureRepo, '--trust'], dataDir);
    expect(addOutput).toContain('trusted');
    const listJson = runCli(['repo', 'list', '--json'], dataDir);
    const parsed = JSON.parse(listJson) as { trusted: boolean }[];
    expect(parsed[0]?.trusted).toBe(true);
  });

  it('exposes `trust` as an alias of `approve`', () => {
    const addOutput = runCli(['repo', 'add', fixtureRepo], dataDir);
    const repositoryId = addOutput.split('\n')[0]?.trim() as string;
    const trustOutput = runCli(['repo', 'trust', repositoryId], dataDir);
    expect(trustOutput).toContain('is now trusted');
    const listJson = runCli(['repo', 'list', '--json'], dataDir);
    const parsed = JSON.parse(listJson) as { id: string; trusted: boolean }[];
    expect(parsed.find((r) => r.id === repositoryId)?.trusted).toBe(true);
  });

  it('refuses to create a task against an untrusted repository, up front', () => {
    const addOutput = runCli(['repo', 'add', fixtureRepo], dataDir);
    const repositoryId = addOutput.split('\n')[0]?.trim() as string;
    // The trust check fires BEFORE any daemon call, so this fails fast without a running daemon.
    const { code, output } = runCliCapture(
      ['task', 'create', 'do a thing', '--repo', repositoryId],
      dataDir,
    );
    expect(code).not.toBe(0);
    expect(output).toContain('not trusted');
    expect(output).toContain(`awb repo trust ${repositoryId}`);
  });
});
