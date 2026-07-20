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
