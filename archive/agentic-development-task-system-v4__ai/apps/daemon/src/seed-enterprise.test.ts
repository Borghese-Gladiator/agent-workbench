import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@workbench/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureEnterpriseProjects,
  enterpriseProjects,
  klaviyoLocalSeedTool,
} from './seed-enterprise.js';

let store: Store;
let artifactsDir: string;
const HOME = '/home/tester';

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-seedent-'));
  store = new Store({ dbPath: ':memory:', artifactsDir });
});
afterEach(() => {
  store.close();
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe('enterpriseProjects', () => {
  it('defines app + fender at the canonical Klaviyo paths, both draft-PR / claude', () => {
    const [app, fender] = enterpriseProjects(HOME);
    expect(app).toMatchObject({
      name: '[klaviyo] app',
      repoPath: '/home/tester/Klaviyo/Repos/app',
      deliveryPolicy: 'create_pr',
      agentRuntime: 'claude',
    });
    expect(fender).toMatchObject({
      name: '[klaviyo] fender',
      repoPath: '/home/tester/Klaviyo/Repos/fender',
      deliveryPolicy: 'create_pr',
      agentRuntime: 'claude',
    });
  });

  it('carries the exact local dev/build commands per repo', () => {
    const [app, fender] = enterpriseProjects(HOME);
    // app: Django dev server via Makefile.
    expect(app.devCommand).toBe('make run-server');
    expect(app.testCommand).toBe('bin/pytest -m unit');
    // fender: run LOCALLY, not against prod data. Every command is prefixed with
    // CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true so it survives a fresh worktree
    // (the enforce-direnv-nix Yarn plugin), and tests go through PnP (`yarn exec
    // turbo`) scoped with --filter (the bare `turbo test` script is a stub).
    const fenderEnv = 'CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true';
    expect(fender.devCommand).toBe(`${fenderEnv} yarn dev -cdL`);
    expect(fender.lintCommand).toBe(`${fenderEnv} yarn lint`);
    expect(fender.typecheckCommand).toBe(`${fenderEnv} yarn check-types`);
    expect(fender.testCommand).toBe(
      `${fenderEnv} yarn exec turbo run test --filter=@klaviyo/performance-dashboard`,
    );
  });

  it('registers klaviyo-local-seed as an external tool on BOTH enterprise repos', () => {
    const [app, fender] = enterpriseProjects(HOME);
    expect(app.externalTools).toEqual([klaviyoLocalSeedTool(HOME)]);
    // Fender pages read the local app backend, so fender gets the same tool.
    expect(fender.externalTools).toEqual([klaviyoLocalSeedTool(HOME)]);
    expect(klaviyoLocalSeedTool(HOME)).toEqual({
      name: 'klaviyo-local-seed',
      root: '/home/tester/GitHub/klaviyo-local-seed',
      docPath: 'CLAUDE.md',
      recipesDir: 'docs/recipes',
      stages: ['implementation', 'feature_e2e'],
    });
  });
});

describe('ensureEnterpriseProjects', () => {
  it('creates both projects with create_pr policy on a fresh store', () => {
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 2, corrected: 0 });

    const projects = store.listProjects();
    expect(projects.map((p) => p.name).sort()).toEqual(['[klaviyo] app', '[klaviyo] fender']);
    for (const p of projects) {
      expect(p.deliveryPolicy).toBe('create_pr');
    }
  });

  it('is idempotent — a second run creates/corrects nothing and does not duplicate', () => {
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 2, corrected: 0 });
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 0, corrected: 0 });
    expect(store.listProjects()).toHaveLength(2);
  });

  it('corrects a drifted policy AND name on an existing project, keeping custom commands', () => {
    // app already exists, misconfigured to merge_to_master with a drifted name and a
    // human-customized test command.
    store.createProject({
      name: 'Klaviyo app',
      repoPath: '/home/tester/Klaviyo/Repos/app',
      defaultBranch: 'master',
      deliveryPolicy: 'merge_to_master',
      testCommand: 'bin/pytest -m custom',
    });

    // fender created; app's policy + name corrected (custom command preserved).
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 1, corrected: 1 });
    const app = store.listProjects().find((p) => p.repoPath.endsWith('/app'));
    expect(app?.name).toBe('[klaviyo] app'); // canonical name enforced
    expect(app?.deliveryPolicy).toBe('create_pr'); // enterprise rule enforced
    expect(app?.testCommand).toBe('bin/pytest -m custom'); // human command untouched
    expect(store.listProjects()).toHaveLength(2); // no duplicate
  });

  it('corrects a drifted name even when the policy is already correct', () => {
    store.createProject({
      name: 'fender',
      repoPath: '/home/tester/Klaviyo/Repos/fender',
      defaultBranch: 'master',
      deliveryPolicy: 'create_pr',
    });

    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 1, corrected: 1 });
    const fender = store.listProjects().find((p) => p.repoPath.endsWith('/fender'));
    expect(fender?.name).toBe('[klaviyo] fender');
  });

  it('persists the app external tools on create and corrects a drifted set on boot', () => {
    ensureEnterpriseProjects(store, HOME);
    const app = () => store.listProjects().find((p) => p.repoPath.endsWith('/app'));
    expect(app()?.externalTools).toEqual([klaviyoLocalSeedTool(HOME)]);

    // Wipe the tools (simulating a stale row from before the tool existed).
    store.setProjectExternalTools(app()!.id, []);
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 0, corrected: 1 });
    expect(app()?.externalTools).toEqual([klaviyoLocalSeedTool(HOME)]);

    // And a matching set is left alone.
    expect(ensureEnterpriseProjects(store, HOME)).toEqual({ created: 0, corrected: 0 });
  });
});
