import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectQaMode, detectRepoShape, type RepoShape } from './qa-mode.js';

const NEITHER: RepoShape = { servesHttp: false, isLibrary: false };

// TASK-73: `AWB_QA_MODE=browser` with nothing serving used to hit a deliberate `exit 1`, dead-ending
// a finished, verified change on a static frontend. The selector must never produce that.
describe('selectQaMode', () => {
  it('drives the browser when a server resolved', () => {
    expect(
      selectQaMode({
        requestedMode: 'browser',
        resolved: { command: 'npm run dev', serves: true, baseUrl: 'http://localhost:5173', source: 'package-script' },
        repoShape: NEITHER,
      }),
    ).toEqual({ mode: 'browser', command: 'npm run dev', baseUrl: 'http://localhost:5173' });
  });

  it('lets an operator-supplied base URL win over the resolver', () => {
    const selection = selectQaMode({
      requestedMode: 'browser',
      resolved: { command: 'npm run dev', serves: true, baseUrl: 'http://localhost:5173', source: 'package-script' },
      repoShape: NEITHER,
      requestedBaseUrl: 'http://localhost:9999',
    });
    expect(selection).toMatchObject({ mode: 'browser', baseUrl: 'http://localhost:9999' });
  });

  // The fallback ladder: the project's own command, then HTTP, then a library import, then the
  // generic executor. Every rung is a real QA mode; none of them is the old hard-fail.
  it.each([
    {
      label: 'a serves:false command — run the project\'s own command',
      resolved: { command: './build/app --check', serves: false as const, source: 'language-default' as const },
      repoShape: { servesHttp: true, isLibrary: true },
      expected: { mode: 'cli-run', command: './build/app --check' },
    },
    {
      label: 'nothing resolved but the repo declares a server dependency',
      resolved: undefined,
      repoShape: { servesHttp: true, isLibrary: false },
      expected: { mode: 'http-api' },
    },
    {
      label: 'nothing resolved and the repo is a library',
      resolved: undefined,
      repoShape: { servesHttp: false, isLibrary: true },
      expected: { mode: 'library' },
    },
    {
      label: 'nothing resolved and nothing recognizable',
      resolved: undefined,
      repoShape: NEITHER,
      expected: { mode: 'cli-default' },
    },
  ])('falls back for $label', ({ resolved, repoShape, expected }) => {
    expect(selectQaMode({ requestedMode: 'browser', resolved, repoShape })).toEqual(expected);
  });

  it.each(['http-api', 'library'] as const)('honors an explicit %s request over any resolution', (requestedMode) => {
    const selection = selectQaMode({
      requestedMode,
      // Even with a real dev server available, the operator's explicit choice wins.
      resolved: { command: 'npm run dev', serves: true, baseUrl: 'http://localhost:5173', source: 'package-script' },
      repoShape: NEITHER,
    });
    expect(selection).toEqual({ mode: requestedMode });
  });

  it('leaves an unset AWB_QA_MODE on the generic executor', () => {
    expect(selectQaMode({ requestedMode: undefined, resolved: undefined, repoShape: { servesHttp: true, isLibrary: true } })).toEqual({
      mode: 'cli-default',
    });
  });
});

describe('detectRepoShape', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-qa-shape-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a server dependency and a library entry point out of package.json', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ main: 'dist/index.js', dependencies: { express: '^4' } }));
    expect(await detectRepoShape(dir)).toEqual({ servesHttp: true, isLibrary: true });
  });

  it('does not call a private app a library', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, main: 'dist/index.js' }));
    expect(await detectRepoShape(dir)).toMatchObject({ isLibrary: false });
  });

  it('reads a Python server dependency out of pyproject.toml', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["fastapi>=0.100"]\n');
    expect(await detectRepoShape(dir)).toEqual({ servesHttp: true, isLibrary: true });
  });

  // Best-effort by design: an unreadable or absent manifest must route to the generic executor,
  // never fail the phase.
  it.each([
    { label: 'no manifest at all', write: undefined },
    { label: 'a malformed package.json', write: '{ not json' },
  ])('reports neither for $label', async ({ write }) => {
    if (write) await writeFile(join(dir, 'package.json'), write);
    expect(await detectRepoShape(dir)).toEqual(NEITHER);
  });
});
