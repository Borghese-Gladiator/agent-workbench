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

  it('drives add -> refresh -> approve -> list -> inspect end to end', () => {
    const addOutput = runCli(['repo', 'add', fixtureRepo], dataDir);
    expect(addOutput).toContain('Registered repository');
    expect(existsSync(join(dataDir, 'database', 'workbench.sqlite'))).toBe(true);

    const idMatch = /Registered repository (\S+)/.exec(addOutput);
    const repositoryId = idMatch?.[1];
    expect(repositoryId).toBeDefined();

    const listOutput = runCli(['repo', 'list'], dataDir);
    expect(listOutput).toContain('[untrusted]');
    expect(listOutput).toContain(repositoryId as string);

    const refreshOutput = runCli(['repo', 'refresh', repositoryId as string], dataDir);
    expect(refreshOutput).toContain('Recorded snapshot');

    const approveOutput = runCli(['repo', 'approve', repositoryId as string], dataDir);
    expect(approveOutput).toContain('is now trusted');

    const listAfterApprove = runCli(['repo', 'list'], dataDir);
    expect(listAfterApprove).toContain('[trusted]');

    const inspectOutput = runCli(['repo', 'inspect', repositoryId as string], dataDir);
    const inspected = JSON.parse(inspectOutput) as { repository: { trusted: boolean }; latestSnapshot: { headSha: string } };
    expect(inspected.repository.trusted).toBe(true);
    expect(inspected.latestSnapshot.headSha).toHaveLength(40);
  });

  it('reports a clear error for an unregistered repository id', () => {
    expect(() => runCli(['repo', 'inspect', 'not-a-real-id'], dataDir)).toThrow();
  });
});
