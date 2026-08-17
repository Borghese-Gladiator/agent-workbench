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
  readGoModule,
  readGoRequires,
  readJvmCoordinates,
  type PackageJson,
  type PythonManifest,
} from './manifests.js';

const MONOREPO_CONTAINER_DIRS = ['apps', 'packages', 'services', 'workers'];

/** Files whose presence makes a directory a discoverable unit (any recognized ecosystem's manifest). */
const UNIT_MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'build.gradle', 'build.gradle.kts', 'pom.xml'];

/** Every manifest a candidate directory declares, read exactly once so linking is a pure map pass. */
interface CandidateManifests {
  pkg: PackageJson | undefined;
  py: PythonManifest[];
  goModule?: string;
  goRequires: string[];
  jvm?: { name?: string; deps: string[] };
}

async function readCandidateManifests(dir: string): Promise<CandidateManifests> {
  const [pkg, py, goModule, goRequires, jvm] = await Promise.all([
    readPackageJson(dir),
    findPythonManifests(dir),
    readGoModule(dir),
    readGoRequires(dir),
    readJvmCoordinates(dir),
  ]);
  return { pkg, py, goModule, goRequires, jvm };
}

/** The names a unit declares as its own, and the names it depends on — resolved across ecosystems. */
interface UnitIdentity {
  names: string[];
  deps: string[];
}

/**
 * Per-ecosystem identity extractors. Mirrors resolveRunCommand's MATCHERS array: adding an ecosystem
 * to the dependency graph is one entry here, reading from the shared manifests already on hand. Each
 * extractor contributes the names a unit is known by and the dependency names it declares; edges are
 * resolved by matching one unit's deps against every unit's names through a single shared map.
 */
type IdentityExtractor = (m: CandidateManifests) => UnitIdentity;

const IDENTITY_EXTRACTORS: IdentityExtractor[] = [
  // JavaScript / TypeScript — package.json name + dependencies/devDependencies.
  ({ pkg }) => ({
    names: pkg?.name ? [pkg.name] : [],
    deps: Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }),
  }),
  // Python — pyproject/poetry distribution name + pyproject/poetry/requirements deps.
  ({ py }) => {
    const name = readPythonPackageName(py);
    return { names: name ? [name] : [], deps: readPythonDependencyNames(py) };
  },
  // Go — go.mod module path + require() module paths.
  ({ goModule, goRequires }) => ({ names: goModule ? [goModule] : [], deps: goRequires }),
  // JVM — group:artifact coordinate + declared dependency coordinates (Maven/Gradle).
  ({ jvm }) => ({ names: jvm?.name ? [jvm.name] : [], deps: jvm?.deps ?? [] }),
];

/** Union of every ecosystem's declared identity for one candidate (names + deps, deduped). */
function extractIdentity(manifests: CandidateManifests): UnitIdentity {
  const names = new Set<string>();
  const deps = new Set<string>();
  for (const extract of IDENTITY_EXTRACTORS) {
    const identity = extract(manifests);
    for (const name of identity.names) names.add(name);
    for (const dep of identity.deps) deps.add(dep);
  }
  return { names: [...names], deps: [...deps] };
}

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

  if (!hasTs && !hasPy) {
    // Non-JS/Python units still participate in the dependency graph (Go modules, JVM projects); they
    // classify by manifest presence so they aren't dropped from discovery. Kind stays 'unknown' —
    // run/serve inference for these lives in resolveRunCommand, not here.
    if (await pathExists(join(dir, 'go.mod'))) return { language: 'go', kind: 'unknown' };
    const isJvm = await Promise.all(
      ['build.gradle', 'build.gradle.kts', 'pom.xml'].map((f) => pathExists(join(dir, f))),
    );
    return isJvm.some(Boolean) ? { language: 'jvm', kind: 'unknown' } : undefined;
  }

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
  // discovery must honor the declared globs too. Only dirs carrying a recognized manifest are kept.
  const workspaceGlobs = await readWorkspaceGlobs(rootDir);
  for (const dir of await expandWorkspaceGlobs(rootDir, workspaceGlobs)) {
    const hasManifest = await Promise.all(UNIT_MANIFEST_FILES.map((f) => pathExists(join(dir, f))));
    if (hasManifest.some(Boolean)) candidateSet.add(dir);
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
  const manifestsByDir = new Map<string, CandidateManifests>(
    await Promise.all(
      candidateDirs.map(async (dir) => [dir, await readCandidateManifests(dir)] as const),
    ),
  );

  // Cross-ecosystem dependency linking: every name a unit declares (npm name, Python distribution,
  // Go module path, JVM coordinate) maps to its unit id, so a dependency edge — from any ecosystem's
  // declared deps — is a single map lookup rather than a scan-and-read over every other candidate.
  const idByPackageName = new Map<string, string>();
  const unitByDir = new Map<string, RepositoryUnit>();
  for (const dir of candidateDirs) {
    const manifests = manifestsByDir.get(dir);
    if (!manifests) continue;
    const classification = await classifyUnit(dir, manifests.pkg, manifests.py);
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
    for (const name of extractIdentity(manifests).names) idByPackageName.set(name, id);
    units.push(unit);
  }

  for (const dir of candidateDirs) {
    const unit = unitByDir.get(dir);
    const manifests = manifestsByDir.get(dir);
    if (!unit || !manifests) continue;
    const seen = new Set<string>();
    for (const depName of extractIdentity(manifests).deps) {
      const depId = idByPackageName.get(depName);
      if (depId && depId !== unit.id && !seen.has(depId)) {
        seen.add(depId);
        unit.dependsOn.push(depId);
      }
    }
  }

  return units;
}
