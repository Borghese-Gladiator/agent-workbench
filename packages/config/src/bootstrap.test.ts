import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLayout, ensureDataDir, initDataDir, WorkbenchConfigSchema } from './index.js';

describe('config bootstrap', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-data-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the full directory layout', () => {
    const layout = resolveLayout(root);
    ensureDataDir(layout);

    expect(existsSync(layout.temporalDir)).toBe(true);
    expect(existsSync(layout.databaseDir)).toBe(true);
    expect(existsSync(layout.artifactsDir)).toBe(true);
    expect(existsSync(layout.cacheRepositoriesDir)).toBe(true);
    expect(existsSync(layout.cacheVideoDir)).toBe(true);
    expect(existsSync(layout.cacheTemporaryContextDir)).toBe(true);
    expect(existsSync(layout.repositoriesDir)).toBe(true);
    expect(existsSync(layout.worktreesDir)).toBe(true);
    expect(existsSync(layout.runtimePortsDir)).toBe(true);
    expect(existsSync(layout.runtimePidsDir)).toBe(true);
    expect(existsSync(layout.runtimeSocketsDir)).toBe(true);
    expect(existsSync(layout.configFile)).toBe(true);
  });

  it('writes a parseable default config.yaml', async () => {
    const layout = resolveLayout(root);
    ensureDataDir(layout);
    const raw = await readFile(layout.configFile, 'utf8');
    expect(raw).toContain('agentProvider');
  });

  it.each(['mock', 'claude', 'codex', 'pi', 'opencode'])(
    'accepts agentProvider=%s (must match AGENT_RUNTIMES in @awb/agent-gateway)',
    (provider) => {
      expect(WorkbenchConfigSchema.parse({ agentProvider: provider }).agentProvider).toBe(provider);
    },
  );

  it('rejects an unknown agentProvider', () => {
    expect(() => WorkbenchConfigSchema.parse({ agentProvider: 'gpt' })).toThrow();
  });

  it('initDataDir reports created=true on first call, false on second', () => {
    // mkdtemp already creates `root` itself, so point AWB_DATA_DIR at a not-yet-existing
    // child of it to genuinely exercise the "first access" branch.
    const freshRoot = join(root, 'awb-root');
    process.env.AWB_DATA_DIR = freshRoot;
    try {
      const a = initDataDir();
      expect(a.created).toBe(true);
      const b = initDataDir();
      expect(b.created).toBe(false);
    } finally {
      delete process.env.AWB_DATA_DIR;
    }
  });
});
