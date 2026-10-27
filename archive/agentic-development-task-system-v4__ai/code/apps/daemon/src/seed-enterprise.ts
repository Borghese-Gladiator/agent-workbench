/**
 * Ensure the two Klaviyo enterprise projects (`app`, `fender`) always exist with the
 * correct delivery policy. Called on daemon boot.
 *
 * These repos must ALWAYS open a draft PR and NEVER squash-merge to their default
 * branch. Rather than guard the delivery action at runtime per repo type, we make the
 * project records themselves carry `deliveryPolicy: 'create_pr'` — the single source of
 * truth the delivery path already reads. Seeding them on start means the policy is
 * correct by construction for every task created against them.
 *
 * Idempotent: keyed by `repoPath`. Missing projects are CREATED; an existing one keeps
 * its human-customized commands but has its `deliveryPolicy` and `name` CORRECTED back to
 * the canonical values — these repos must never merge to their default branch and must
 * carry their canonical `[klaviyo] …` name, so both are enforced on every boot rather
 * than respected if drifted.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExternalToolConfig } from '@workbench/core';
import type { NewProject, Store } from '@workbench/store';
import { logger } from './logger.js';

const log = logger.child({ component: 'seed-enterprise' });

/**
 * The `klaviyo-local-seed` helper CLI — seeds the LOCAL app dev env (loginable
 * accounts, feature flags, dashboards, events) by importing app's real models.
 * Lives in its own personal checkout; the workbench only points stage agents at
 * it. Injected for the shell-running stages: `implementation` (construct data to
 * reproduce/verify while building) and `feature_e2e` (seed + verify real runtime
 * state instead of grep-based checks). Registered on BOTH enterprise projects:
 * fender pages read the local app backend, so fender UI work needs the same
 * seeded accounts/data. Fail-open: if the checkout is missing on a machine, the
 * injection is silently skipped (see `composeExternalToolsText`).
 */
export function klaviyoLocalSeedTool(home: string = homedir()): ExternalToolConfig {
  return {
    name: 'klaviyo-local-seed',
    root: join(home, 'GitHub', 'klaviyo-local-seed'),
    docPath: 'CLAUDE.md',
    recipesDir: 'docs/recipes',
    stages: ['implementation', 'feature_e2e'],
  };
}

/** The fixed enterprise projects, at their canonical local checkouts. */
export function enterpriseProjects(home: string = homedir()): NewProject[] {
  return [
    {
      name: '[klaviyo] app',
      description: 'Klaviyo app monorepo (Python / Django). Always delivers via draft PR.',
      repoPath: join(home, 'Klaviyo', 'Repos', 'app'),
      defaultBranch: 'master',
      agentRuntime: 'claude',
      // Enterprise contract: open a draft PR, never merge to the default branch.
      deliveryPolicy: 'create_pr',
      testCommand: 'bin/pytest -m unit',
      // app's Makefile run-server target (Django dev server).
      devCommand: 'make run-server',
      // The local-data seeding CLI — how app agents get real accounts/flags/events
      // to build against and verify with.
      externalTools: [klaviyoLocalSeedTool(home)],
    },
    {
      name: '[klaviyo] fender',
      description: 'Klaviyo fender monorepo (React / TypeScript). Always delivers via draft PR.',
      repoPath: join(home, 'Klaviyo', 'Repos', 'fender'),
      defaultBranch: 'master',
      agentRuntime: 'claude',
      // Enterprise contract: open a draft PR, never merge to the default branch.
      deliveryPolicy: 'create_pr',
      // Fender validation in a TASK WORKTREE has four gotchas (all learned from a live
      // CORE-729 run), so the commands below are written to survive them:
      //   1. A custom Yarn plugin (`enforce-direnv-nix`) hard-fails EVERY `yarn`/turbo
      //      script unless direnv+Nix are loaded — which a fresh worktree never is. The
      //      sanctioned escape hatch is `SKIP_DIRENV_NIX_ENFORCEMENT=true`.
      //   2. That escape hatch covers the OUTER `yarn exec turbo`, but turbo only forwards
      //      a curated env to the package scripts it spawns (`globalPassThroughEnv`), and
      //      SKIP_DIRENV_NIX_ENFORCEMENT is NOT on that list — so the INNER `test` script
      //      re-trips the guard. `CI` *is* on globalPassThroughEnv, and `CI=true` also
      //      satisfies the guard, so we set both: SKIP for the outer call, CI for the inner.
      //   3. It's a Yarn PnP repo with no `node_modules/.bin`, so `turbo` isn't on PATH;
      //      it must be invoked through PnP via `yarn exec turbo`.
      //   4. The bare `turbo test` package script is a deliberate stub that just prints
      //      usage and exits 1 — tests MUST be scoped with `--filter`. We default the
      //      filter to the perf-dashboard package the demo ticket touches; override the
      //      project's testCommand per ticket for a different package.
      // NOTE: the worktree must have had `yarn install` run in it first (PnP populates
      // .yarn/ on demand); the agent's implementation stage handles that when it runs tests.
      testCommand:
        'CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true yarn exec turbo run test --filter=@klaviyo/performance-dashboard',
      lintCommand: 'CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true yarn lint',
      typecheckCommand: 'CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true yarn check-types',
      // Run fender LOCALLY (-L) and NOT against prod data. -c -d -L are the local flags.
      devCommand: 'CI=true SKIP_DIRENV_NIX_ENFORCEMENT=true yarn dev -cdL',
      // Fender pages read the LOCAL app backend, so the same seeding CLI provides
      // the accounts/data a fender UI change needs for real verification.
      externalTools: [klaviyoLocalSeedTool(home)],
    },
  ];
}

/** Outcome of a seeding pass: how many enterprise projects were created vs policy-fixed. */
export interface EnterpriseSeedResult {
  created: number;
  corrected: number;
}

/**
 * Ensure the enterprise projects exist with their canonical name + `create_pr` policy
 * (idempotent by `repoPath`). Missing ones are created; an existing one keeps its
 * human-customized commands but has a drifted `deliveryPolicy` or `name` corrected back
 * to the canonical value. Never throws on a project that already exists.
 */
export function ensureEnterpriseProjects(
  store: Store,
  home: string = homedir(),
): EnterpriseSeedResult {
  const existing = new Map(store.listProjects().map((p) => [p.repoPath, p]));
  let created = 0;
  let corrected = 0;
  for (const project of enterpriseProjects(home)) {
    const found = existing.get(project.repoPath);
    if (!found) {
      const row = store.createProject(project);
      created++;
      log.info(
        { id: row.id, name: project.name, repoPath: project.repoPath, policy: row.deliveryPolicy },
        'created enterprise project',
      );
      continue;
    }
    // Present already: keep human-customized commands, but enforce the draft-PR rule
    // AND the canonical name. Either drift counts as a single correction.
    let wasCorrected = false;
    if (found.deliveryPolicy !== 'create_pr') {
      store.setProjectDeliveryPolicy(found.id, 'create_pr');
      wasCorrected = true;
      log.warn(
        { id: found.id, name: found.name, was: found.deliveryPolicy },
        'corrected enterprise project deliveryPolicy -> create_pr',
      );
    }
    if (found.name !== project.name) {
      store.setProjectName(found.id, project.name);
      wasCorrected = true;
      log.warn(
        { id: found.id, was: found.name, now: project.name },
        'corrected enterprise project name -> canonical',
      );
    }
    // The external-tool set is canonical too (like name/policy, unlike the
    // human-customizable commands): enforce it on every boot so a new tool added
    // here reaches existing project rows.
    const canonicalTools = project.externalTools ?? [];
    if (JSON.stringify(found.externalTools) !== JSON.stringify(canonicalTools)) {
      store.setProjectExternalTools(found.id, canonicalTools);
      wasCorrected = true;
      log.warn(
        { id: found.id, name: found.name, tools: canonicalTools.map((t) => t.name) },
        'corrected enterprise project externalTools -> canonical',
      );
    }
    if (wasCorrected) {
      corrected++;
    } else {
      log.info({ name: project.name, repoPath: project.repoPath }, 'enterprise project present');
    }
  }
  return { created, corrected };
}
