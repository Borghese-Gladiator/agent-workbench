import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepositoryUnit, RepositoryUnitKind, RepositoryUnitLanguage } from '@awb/domain';

const MONOREPO_GROUP_DIRS = ['apps', 'packages', 'workers', 'services'];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);

interface PackageJson {
  name?: string;
  bin?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function detectPackageManager(unitRoot: string, pkg?: PackageJson): string | undefined {
  if (pkg?.packageManager) {
    return pkg.packageManager.split('@')[0];
  }
  if (existsSync(join(unitRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(unitRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(unitRoot, 'package-lock.json'))) return 'npm';
  if (existsSync(join(unitRoot, 'poetry.lock'))) return 'poetry';
  if (existsSync(join(unitRoot, 'requirements.txt'))) return 'pip';
  if (pkg) return 'npm';
  return undefined;
}

function hasAnyDep(pkg: PackageJson, names: string[]): boolean {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.some((name) => name in all);
}

function walkFiles(root: string, maxDepth = 3): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (isDir(full)) {
        walk(full, depth + 1);
      } else {
        results.push(full);
      }
    }
  }
  walk(root, 0);
  return results;
}

function inferTypescriptKind(unitRoot: string, pkg: PackageJson): RepositoryUnitKind {
  if (pkg.bin) {
    return 'cli';
  }
  if (hasAnyDep(pkg, ['react', 'vue', 'svelte'])) {
    return 'web';
  }
  if (existsSync(join(unitRoot, 'index.html'))) {
    return 'web';
  }
  if (hasAnyDep(pkg, ['express', 'fastify', 'koa', '@nestjs/core'])) {
    return 'api';
  }
  const files = walkFiles(unitRoot);
  if (files.some((file) => /routes?\.(ts|js)$/.test(file))) {
    return 'api';
  }
  if (pkg.name?.startsWith('@') || unitRoot.includes(`${join('packages', '')}`)) {
    return 'library';
  }
  return 'unknown';
}

function inferPythonKind(unitRoot: string): RepositoryUnitKind {
  const files = walkFiles(unitRoot);
  const hasMain = files.some((file) => file.endsWith('__main__.py'));
  const hasMainGuard = files.some((file) => {
    if (!file.endsWith('.py')) return false;
    try {
      return readFileSync(file, 'utf8').includes('__name__ == "__main__"');
    } catch {
      return false;
    }
  });
  if (hasMain || hasMainGuard) {
    return 'cli';
  }

  let requirements = '';
  const reqPath = join(unitRoot, 'requirements.txt');
  if (existsSync(reqPath)) {
    requirements = readFileSync(reqPath, 'utf8');
  }
  const pyprojectPath = join(unitRoot, 'pyproject.toml');
  let pyproject = '';
  if (existsSync(pyprojectPath)) {
    pyproject = readFileSync(pyprojectPath, 'utf8');
  }
  const combined = `${requirements}\n${pyproject}`.toLowerCase();
  if (/fastapi|flask|django/.test(combined)) {
    return 'api';
  }

  return 'library';
}

function unitIdFor(rootDir: string, unitRoot: string): string {
  const rel = relative(rootDir, unitRoot);
  return rel === '' ? '.' : rel;
}

interface DiscoveredUnit {
  root: string;
  language: RepositoryUnitLanguage;
  kind: RepositoryUnitKind;
  framework?: string;
  packageManager?: string;
  pkg?: PackageJson;
}

function inferFramework(pkg?: PackageJson): string | undefined {
  if (!pkg) return undefined;
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const known = ['react', 'vue', 'svelte', 'express', 'fastify', 'koa', 'next', '@nestjs/core'];
  return known.find((name) => name in all);
}

function discoverUnitAt(rootDir: string, unitRoot: string): DiscoveredUnit | undefined {
  const packageJsonPath = join(unitRoot, 'package.json');
  const pyprojectPath = join(unitRoot, 'pyproject.toml');
  const setupPyPath = join(unitRoot, 'setup.py');

  const hasPackageJson = existsSync(packageJsonPath);
  const hasPyproject = existsSync(pyprojectPath) || existsSync(setupPyPath);

  if (!hasPackageJson && !hasPyproject) {
    return undefined;
  }

  const pkg = hasPackageJson ? readJson<PackageJson>(packageJsonPath) : undefined;

  let language: RepositoryUnitLanguage;
  if (hasPackageJson && hasPyproject) {
    language = 'mixed';
  } else if (hasPackageJson) {
    language = 'typescript';
  } else {
    language = 'python';
  }

  const kind: RepositoryUnitKind =
    language === 'python'
      ? inferPythonKind(unitRoot)
      : language === 'typescript'
        ? inferTypescriptKind(unitRoot, pkg ?? {})
        : 'unknown';

  return {
    root: unitRoot,
    language,
    kind,
    framework: inferFramework(pkg),
    packageManager: detectPackageManager(unitRoot, pkg),
    pkg,
  };
}

export function discoverUnits(rootDir: string): RepositoryUnit[] {
  const discovered = new Map<string, DiscoveredUnit>();

  const rootUnit = discoverUnitAt(rootDir, rootDir);
  if (rootUnit) {
    discovered.set(rootDir, rootUnit);
  }

  for (const group of MONOREPO_GROUP_DIRS) {
    const groupDir = join(rootDir, group);
    if (!isDir(groupDir)) continue;
    for (const child of listDirs(groupDir)) {
      const unitRoot = join(groupDir, child);
      const unit = discoverUnitAt(rootDir, unitRoot);
      if (unit) {
        discovered.set(unitRoot, unit);
      }
    }
  }

  if (discovered.size === 0) {
    for (const child of listDirs(rootDir)) {
      const unitRoot = join(rootDir, child);
      const unit = discoverUnitAt(rootDir, unitRoot);
      if (unit) {
        discovered.set(unitRoot, unit);
      }
    }
  }

  const idByRoot = new Map<string, string>();
  for (const unitRoot of discovered.keys()) {
    idByRoot.set(unitRoot, unitIdFor(rootDir, unitRoot));
  }
  const idByPackageName = new Map<string, string>();
  for (const [unitRoot, unit] of discovered) {
    if (unit.pkg?.name) {
      const id = idByRoot.get(unitRoot);
      if (id) idByPackageName.set(unit.pkg.name, id);
    }
  }

  const units: RepositoryUnit[] = [];
  for (const [unitRoot, unit] of discovered) {
    const id = idByRoot.get(unitRoot);
    if (!id) continue;

    const dependsOn: string[] = [];
    const allDeps = { ...unit.pkg?.dependencies, ...unit.pkg?.devDependencies };
    for (const [depName, versionSpec] of Object.entries(allDeps)) {
      if (typeof versionSpec === 'string' && versionSpec.startsWith('workspace:')) {
        const depUnitId = idByPackageName.get(depName);
        if (depUnitId && depUnitId !== id) {
          dependsOn.push(depUnitId);
        }
      }
    }

    units.push({
      id,
      root: unitRoot,
      language: unit.language,
      kind: unit.kind,
      framework: unit.framework,
      packageManager: unit.packageManager,
      dependsOn,
    });
  }

  return units.sort((a, b) => a.id.localeCompare(b.id));
}
