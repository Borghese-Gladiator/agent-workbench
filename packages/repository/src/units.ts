import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RepositoryUnit, RepositoryUnitKind, RepositoryUnitLanguage } from '@awb/domain';
import {
  readPackageJson,
  findPythonManifests,
  listDirs,
  pathExists,
  readWorkspaceGlobs,
  expandWorkspaceGlobs,
} from './manifests.js';

const MONOREPO_CONTAINER_DIRS = ['apps', 'packages', 'services', 'workers'];

async function classifyUnit(dir: string): Promise<{
  language: RepositoryUnitLanguage;
  kind: RepositoryUnitKind;
  framework?: string;
  packageManager?: string;
} | undefined> {
  const pkg = await readPackageJson(dir);
  const pythonManifests = await findPythonManifests(dir);
  const hasTs = pkg !== undefined;
  const hasPy = pythonManifests.length > 0;

  if (!hasTs && !hasPy) return undefined;

  const language: RepositoryUnitLanguage = hasTs && hasPy ? 'mixed' : hasTs ? 'typescript' : 'python';

  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  let framework: string | undefined;
  let kind: RepositoryUnitKind = 'unknown';

  if (hasTs) {
    if (deps.react || deps.vue || deps.svelte) {
      framework = deps.react ? 'react' : deps.vue ? 'vue' : 'svelte';
      kind = 'web';
    } else if (deps.express || deps.fastify || deps.koa) {
      framework = deps.express ? 'express' : deps.fastify ? 'fastify' : 'koa';
      kind = 'api';
    } else if (pkg?.bin) {
      kind = 'cli';
    } else if (await pathExists(join(dir, 'index.html'))) {
      kind = 'web';
    } else if (pkg?.name?.includes('worker')) {
      kind = 'worker';
    } else if (pkg?.scripts?.start || pkg?.scripts?.dev) {
      kind = 'application';
    } else {
      kind = 'library';
    }
  } else if (hasPy) {
    const pyproject = pythonManifests.find((m) => m.kind === 'pyproject');
    const raw = pyproject?.raw ?? '';
    if (/fastapi|flask|django/i.test(raw)) {
      framework = /fastapi/i.test(raw) ? 'fastapi' : /flask/i.test(raw) ? 'flask' : 'django';
      kind = 'api';
    } else if (await pathExists(join(dir, '__main__.py'))) {
      kind = 'cli';
    } else {
      kind = 'library';
    }
  }

  const packageManager = pkg?.packageManager?.split('@')[0];

  return { language, kind, framework, packageManager };
}

/**
 * Discovers repository units without assuming a fixed shape: checks the root itself, then a
 * conventional set of monorepo container directories (apps/, packages/, services/, workers/) one
 * level deep. This is a heuristic, not an assumption the rest of the system depends on structurally.
 */
export async function discoverUnits(rootDir: string): Promise<RepositoryUnit[]> {
  const units: RepositoryUnit[] = [];
  const rootClassification = await classifyUnit(rootDir);

  const candidateSet = new Set<string>();
  for (const container of MONOREPO_CONTAINER_DIRS) {
    const containerPath = join(rootDir, container);
    if (!(await pathExists(containerPath))) continue;
    for (const child of await listDirs(containerPath)) {
      candidateSet.add(join(containerPath, child));
    }
  }
  // Workspace-declared packages (npm/yarn `workspaces`, pnpm-workspace.yaml) may live outside the
  // conventional container dirs (e.g. `games/*`, `portal`) or be nested (`packages/engines/*`), so
  // discovery must honor the declared globs too. Only dirs with a manifest are kept.
  const workspaceGlobs = await readWorkspaceGlobs(rootDir);
  for (const dir of await expandWorkspaceGlobs(rootDir, workspaceGlobs)) {
    if (await pathExists(join(dir, 'package.json'))) candidateSet.add(dir);
  }
  const candidateDirs = [...candidateSet].filter((dir) => dir !== rootDir);

  // The root is a discoverable unit in its own right — critically, in a workspace repo whose test/
  // build scripts live in the ROOT package.json (e.g. a single root `vitest run` covering every
  // workspace package), dropping it here was exactly why refresh discovered 0 verification commands.
  // Always include the root when it classifies, alongside any sub-packages.
  if (rootClassification) {
    units.push({
      id: randomUUID(),
      root: '.',
      language: rootClassification.language,
      kind: rootClassification.kind,
      framework: rootClassification.framework,
      packageManager: rootClassification.packageManager,
      dependsOn: [],
    });
  }

  if (candidateDirs.length === 0) {
    return units;
  }

  const idByRelativeRoot = new Map<string, string>();
  for (const dir of candidateDirs) {
    const classification = await classifyUnit(dir);
    if (!classification) continue;
    const relativeRoot = dir.slice(rootDir.length + 1);
    const id = randomUUID();
    idByRelativeRoot.set(relativeRoot, id);
    units.push({
      id,
      root: relativeRoot,
      language: classification.language,
      kind: classification.kind,
      framework: classification.framework,
      packageManager: classification.packageManager,
      dependsOn: [],
    });
  }

  for (const dir of candidateDirs) {
    const relativeRoot = dir.slice(rootDir.length + 1);
    const unit = units.find((u) => u.root === relativeRoot);
    if (!unit) continue;
    const pkg = await readPackageJson(dir);
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    for (const depName of Object.keys(deps)) {
      for (const [otherRoot, otherId] of idByRelativeRoot) {
        if (otherId === unit.id) continue;
        const otherPkg = await readPackageJson(join(rootDir, otherRoot));
        if (otherPkg?.name === depName) {
          unit.dependsOn.push(otherId);
        }
      }
    }
  }

  return units;
}
