import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  bin?: string | Record<string, string>;
}

export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return undefined;
  }
}

export interface PythonManifest {
  kind: 'pyproject' | 'setup.py' | 'requirements.txt' | 'setup.cfg';
  path: string;
  raw: string;
}

export async function findPythonManifests(dir: string): Promise<PythonManifest[]> {
  const candidates: Array<{ file: string; kind: PythonManifest['kind'] }> = [
    { file: 'pyproject.toml', kind: 'pyproject' },
    { file: 'setup.py', kind: 'setup.py' },
    { file: 'setup.cfg', kind: 'setup.cfg' },
    { file: 'requirements.txt', kind: 'requirements.txt' },
  ];
  const found: PythonManifest[] = [];
  for (const { file, kind } of candidates) {
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      found.push({ kind, path: join(dir, file), raw });
    } catch {
      continue;
    }
  }
  return found;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Very small pyproject.toml value scraper — enough to detect tool sections without a full TOML parser. */
export function pyprojectHasSection(raw: string, section: string): boolean {
  return new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\]`, 'm').test(raw);
}

/**
 * Reads the workspace-package globs a repo declares, so discovery can recurse into workspace
 * sub-packages that don't sit under the conventional monorepo container dirs (e.g. `games/*`,
 * `portal`). Handles both npm/yarn `workspaces` in package.json (array or `{ packages: [] }`) and
 * pnpm's `pnpm-workspace.yaml`. Returns the raw glob patterns; expansion is the caller's job.
 */
export async function readWorkspaceGlobs(dir: string): Promise<string[]> {
  const globs = new Set<string>();

  const pkg = await readPackageJson(dir);
  if (Array.isArray(pkg?.workspaces)) {
    for (const g of pkg.workspaces) globs.add(g);
  } else if (pkg?.workspaces?.packages) {
    for (const g of pkg.workspaces.packages) globs.add(g);
  }

  try {
    const raw = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    for (const match of raw.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) {
      globs.add((match[1] as string).trim());
    }
  } catch {
    // no pnpm workspace file
  }

  return [...globs];
}

/**
 * Expands the simple workspace glob patterns this codebase encounters (`dir`, `dir/*`) into
 * concrete directory paths relative to `rootDir` that contain a package manifest. Deliberately
 * supports only a trailing single-level `*` (and plain paths) — the shapes real workspace configs
 * use — rather than pulling in a full glob dependency.
 */
export async function expandWorkspaceGlobs(rootDir: string, globs: string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const container = join(rootDir, glob.slice(0, -2));
      for (const child of await listDirs(container)) {
        dirs.add(join(container, child));
      }
    } else {
      const candidate = join(rootDir, glob);
      if (await pathExists(join(candidate, 'package.json'))) {
        dirs.add(candidate);
      }
    }
  }
  return [...dirs];
}
