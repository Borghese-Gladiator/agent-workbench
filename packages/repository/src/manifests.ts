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

/** Reads a file's text, returning undefined when it is absent — the common "probe a manifest" shape. */
export async function readTextFile(dir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, file), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Extracts the first script entry from a Procfile (`web: <cmd>` preferred, else the first process).
 * Heroku-style Procfiles are the canonical explicit run declaration across every language, so this is
 * the highest-confidence source. Returns the raw command string, or undefined when absent/empty.
 */
export async function readProcfileCommand(dir: string): Promise<string | undefined> {
  const raw = await readTextFile(dir, 'Procfile');
  if (!raw) return undefined;
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
  const web = lines.find((l) => /^web\s*:/.test(l));
  const chosen = web ?? lines[0];
  if (!chosen) return undefined;
  const cmd = chosen.replace(/^[A-Za-z0-9_-]+\s*:/, '').trim();
  return cmd.length > 0 ? cmd : undefined;
}

/** A docker-compose service's run command + the host ports it publishes (a strong "this serves" signal). */
export interface ComposeService {
  name: string;
  command?: string;
  ports: number[];
}

/**
 * Scrapes services from a docker-compose file (`docker-compose.yml`/`compose.yaml`). A deliberately
 * small indentation-based scraper (repo convention: no YAML dependency) — enough to read each
 * service's `command:` and published host ports from `ports:` entries like `"8000:8000"`. A service
 * with a published port is a server; the port feeds the browser-QA baseUrl.
 */
export async function readComposeServices(dir: string): Promise<ComposeService[]> {
  const raw =
    (await readTextFile(dir, 'docker-compose.yml')) ??
    (await readTextFile(dir, 'docker-compose.yaml')) ??
    (await readTextFile(dir, 'compose.yml')) ??
    (await readTextFile(dir, 'compose.yaml'));
  if (!raw) return [];
  const lines = raw.split('\n');
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | undefined;
  for (const line of lines) {
    if (/^services\s*:/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line)) break; // dedent out of `services:`
    const service = line.match(/^ {2}([A-Za-z0-9._-]+)\s*:\s*$/);
    if (service) {
      current = { name: service[1] as string, ports: [] };
      services.push(current);
      continue;
    }
    if (!current) continue;
    const command = line.match(/^\s+command\s*:\s*(.+)$/);
    if (command) {
      current.command = (command[1] as string).replace(/^["']|["']$/g, '').trim();
      continue;
    }
    const port = line.match(/(\d{2,5})\s*:\s*\d{2,5}/);
    if (port && /^\s*-/.test(line)) current.ports.push(Number.parseInt(port[1] as string, 10));
  }
  return services;
}

/**
 * Returns the target names declared in a Makefile / justfile / Taskfile.yml, so callers can spot a
 * conventional `run`/`dev`/`serve`/`start` entrypoint. Make targets are `name:`; just recipes are
 * `name:`; Taskfile tasks sit under `tasks:` as `name:`. Small scraper, no full parser.
 */
export async function readMakeLikeTargets(dir: string): Promise<{ runner: 'make' | 'just' | 'task'; targets: string[] } | undefined> {
  const make = await readTextFile(dir, 'Makefile');
  if (make) {
    const targets = [...make.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1] as string);
    if (targets.length > 0) return { runner: 'make', targets };
  }
  const just = await readTextFile(dir, 'justfile');
  if (just) {
    const targets = [...just.matchAll(/^([A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1] as string);
    if (targets.length > 0) return { runner: 'just', targets };
  }
  const taskfile = (await readTextFile(dir, 'Taskfile.yml')) ?? (await readTextFile(dir, 'Taskfile.yaml'));
  if (taskfile) {
    const inTasks = taskfile.split(/^tasks\s*:/m)[1];
    if (inTasks) {
      const targets = [...inTasks.matchAll(/^ {2}([A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1] as string);
      if (targets.length > 0) return { runner: 'task', targets };
    }
  }
  return undefined;
}

/** Reads the `[scripts]` section of a Pipfile as name→command (an explicit Python run declaration). */
export async function readPipfileScripts(dir: string): Promise<Record<string, string>> {
  const raw = await readTextFile(dir, 'Pipfile');
  if (!raw) return {};
  const section = raw.split(/^\[scripts\]/m)[1];
  if (!section) return {};
  const body = section.split(/^\[/m)[0] ?? '';
  const scripts: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*["'](.+?)["']\s*$/gm)) {
    scripts[m[1] as string] = m[2] as string;
  }
  return scripts;
}

/** Reads pyproject `[project.scripts]` / `[tool.poetry.scripts]` console entrypoints as name→target. */
export async function readPyprojectScripts(dir: string): Promise<Record<string, string>> {
  const raw = await readTextFile(dir, 'pyproject.toml');
  if (!raw) return {};
  const scripts: Record<string, string> = {};
  for (const header of ['[project.scripts]', '[tool.poetry.scripts]']) {
    const after = raw.split(header)[1];
    if (!after) continue;
    const body = after.split(/^\[/m)[0] ?? '';
    for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*["'](.+?)["']\s*$/gm)) {
      scripts[m[1] as string] = m[2] as string;
    }
  }
  return scripts;
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
