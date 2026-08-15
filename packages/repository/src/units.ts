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
  readPythonPackageName,
  readPythonDependencyNames,
  type PackageJson,
  type PythonManifest,
} from './manifests.js';

const MONOREPO_CONTAINER_DIRS = ['apps', 'packages', 'services', 'workers'];

async function classifyUnit(
  dir: string,
  pkg: PackageJson | undefined,
  pythonManifests: PythonManifest[],
): Promise<{
  language: RepositoryUnitLanguage;
  kind: RepositoryUnitKind;
  framework?: string;
  packageManager?: string;
} | undefined> {
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
  const rootClassification = await classifyUnit(
    rootDir,
    await readPackageJson(rootDir),
    await findPythonManifests(rootDir),
  );

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
  // discovery must honor the declared globs too. Only dirs carrying a manifest (JS or Python) are kept.
  const workspaceGlobs = await readWorkspaceGlobs(rootDir);
  for (const dir of await expandWorkspaceGlobs(rootDir, workspaceGlobs)) {
    if (
      (await pathExists(join(dir, 'package.json'))) ||
      (await pathExists(join(dir, 'pyproject.toml')))
    ) {
      candidateSet.add(dir);
    }
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

  // Read each candidate's manifests exactly once. The dependency-linking pass below resolves
  // workspace deps through these cached manifests instead of re-reading every other package's
  // manifest per dependency — on a large monorepo (~600 packages) the old O(n^2) re-read did
  // hundreds of thousands of disk reads on the event loop and blocked discovery past the worker's
  // callback timeout.
  const manifestsByDir = new Map<string, { pkg: PackageJson | undefined; py: PythonManifest[] }>(
    await Promise.all(
      candidateDirs.map(
        async (dir) =>
          [dir, { pkg: await readPackageJson(dir), py: await findPythonManifests(dir) }] as const,
      ),
    ),
  );

  // Cross-ecosystem dependency linking: a unit's declared package name (npm package name OR Python
  // distribution name) maps to its unit id, so a dependency edge — from either a JS dep or a Python
  // requirement — is a single map lookup rather than a scan-and-read over every other candidate.
  const idByPackageName = new Map<string, string>();
  const unitByDir = new Map<string, RepositoryUnit>();
  for (const dir of candidateDirs) {
    const { pkg, py } = manifestsByDir.get(dir) ?? { pkg: undefined, py: [] };
    const classification = await classifyUnit(dir, pkg, py);
    if (!classification) continue;
    const relativeRoot = dir.slice(rootDir.length + 1);
    const id = randomUUID();
    const unit: RepositoryUnit = {
      id,
      root: relativeRoot,
      language: classification.language,
      kind: classification.kind,
      framework: classification.framework,
      packageManager: classification.packageManager,
      dependsOn: [],
    };
    unitByDir.set(dir, unit);
    if (pkg?.name) idByPackageName.set(pkg.name, id);
    const pyName = readPythonPackageName(py);
    if (pyName) idByPackageName.set(pyName, id);
    units.push(unit);
  }

  for (const dir of candidateDirs) {
    const unit = unitByDir.get(dir);
    if (!unit) continue;
    const { pkg, py } = manifestsByDir.get(dir) ?? { pkg: undefined, py: [] };
    const declaredDeps = [
      ...Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }),
      ...readPythonDependencyNames(py),
    ];
    const seen = new Set<string>();
    for (const depName of declaredDeps) {
      const depId = idByPackageName.get(depName);
      if (depId && depId !== unit.id && !seen.has(depId)) {
        seen.add(depId);
        unit.dependsOn.push(depId);
      }
    }
  }

  return units;
}
