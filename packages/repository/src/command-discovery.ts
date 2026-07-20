import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandPurpose } from '@awb/domain';
import type { DiscoveredCommand } from './discovery-types.js';
import { readPackageJson, findPythonManifests, pathExists, pyprojectHasSection } from './manifests.js';

/**
 * Command discovery follows a fixed priority order (highest first). Callers should keep only the
 * first command found per purpose across sources, in this order:
 *   1. explicit workbench repository configuration (not handled here — see @awb/config)
 *   2. existing repository instructions (CLAUDE.md / AGENTS.md — not command-bearing, skipped)
 *   3. CI workflows
 *   4. Makefile, Taskfile, justfile, tox, nox
 *   5. package.json scripts
 *   6. Python configuration
 *   7. framework conventions
 *   8. agent inference (not handled here — a later fallback layer)
 */
export const DISCOVERY_SOURCE_PRIORITY = [
  'ci',
  'task-runner',
  'makefile',
  'package-script',
  'repository-config',
] as const;

const SCRIPT_NAME_TO_PURPOSE: Record<string, CommandPurpose> = {
  build: 'build',
  start: 'start',
  dev: 'start',
  test: 'unit-test',
  'test:unit': 'unit-test',
  'test:integration': 'integration-test',
  lint: 'lint',
  format: 'format',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  install: 'install',
  healthcheck: 'healthcheck',
};

export async function discoverPackageJsonCommands(dir: string): Promise<DiscoveredCommand[]> {
  const pkg = await readPackageJson(dir);
  if (!pkg?.scripts) return [];
  const packageManager = pkg.packageManager?.split('@')[0] ?? 'npm';
  const runner = packageManager === 'yarn' ? 'yarn' : packageManager === 'pnpm' ? 'pnpm' : 'npm run';

  const commands: DiscoveredCommand[] = [];
  for (const [scriptName, scriptBody] of Object.entries(pkg.scripts)) {
    const purpose = SCRIPT_NAME_TO_PURPOSE[scriptName] ?? classifyCustomScript(scriptName, scriptBody);
    commands.push({
      purpose,
      command: `${runner} ${scriptName}`,
      cwd: dir,
      source: 'package-script',
    });
  }
  return commands;
}

function classifyCustomScript(name: string, body: string): CommandPurpose {
  const haystack = `${name} ${body}`.toLowerCase();
  if (haystack.includes('test')) return 'unit-test';
  if (haystack.includes('lint')) return 'lint';
  if (haystack.includes('format') || haystack.includes('prettier')) return 'format';
  if (haystack.includes('typecheck') || haystack.includes('tsc')) return 'typecheck';
  if (haystack.includes('build')) return 'build';
  return 'custom';
}

export async function discoverMakefileCommands(dir: string): Promise<DiscoveredCommand[]> {
  const makefilePath = join(dir, 'Makefile');
  if (!(await pathExists(makefilePath))) return [];
  const raw = await readFile(makefilePath, 'utf8');
  const targets = [...raw.matchAll(/^([a-zA-Z0-9_.-]+):(?!=)/gm)].map((m) => m[1] as string);
  const commands: DiscoveredCommand[] = [];
  for (const target of targets) {
    if (target.startsWith('.')) continue;
    commands.push({
      purpose: classifyCustomScript(target, target),
      command: `make ${target}`,
      cwd: dir,
      source: 'makefile',
    });
  }
  return commands;
}

export async function discoverTaskRunnerCommands(dir: string): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];

  const justfilePath = join(dir, 'justfile');
  if (await pathExists(justfilePath)) {
    const raw = await readFile(justfilePath, 'utf8');
    for (const match of raw.matchAll(/^([a-zA-Z0-9_-]+)( .*)?:/gm)) {
      const recipe = match[1] as string;
      commands.push({
        purpose: classifyCustomScript(recipe, recipe),
        command: `just ${recipe}`,
        cwd: dir,
        source: 'task-runner',
      });
    }
  }

  const taskfilePath = join(dir, 'Taskfile.yml');
  if (await pathExists(taskfilePath)) {
    const raw = await readFile(taskfilePath, 'utf8');
    for (const match of raw.matchAll(/^\s{2}([a-zA-Z0-9_:-]+):\s*$/gm)) {
      const task = match[1] as string;
      commands.push({
        purpose: classifyCustomScript(task, task),
        command: `task ${task}`,
        cwd: dir,
        source: 'task-runner',
      });
    }
  }

  const toxPath = join(dir, 'tox.ini');
  if (await pathExists(toxPath)) {
    commands.push({
      purpose: 'unit-test',
      command: 'tox',
      cwd: dir,
      source: 'task-runner',
    });
  }

  const noxPath = join(dir, 'noxfile.py');
  if (await pathExists(noxPath)) {
    const raw = await readFile(noxPath, 'utf8');
    for (const match of raw.matchAll(/def\s+([a-zA-Z0-9_]+)\s*\(/g)) {
      const session = match[1] as string;
      commands.push({
        purpose: classifyCustomScript(session, session),
        command: `nox -s ${session}`,
        cwd: dir,
        source: 'task-runner',
      });
    }
  }

  return commands;
}

export async function discoverCiCommands(dir: string): Promise<DiscoveredCommand[]> {
  const workflowsDir = join(dir, '.github', 'workflows');
  const commands: DiscoveredCommand[] = [];
  const { readdir } = await import('node:fs/promises');
  let files: string[];
  try {
    files = (await readdir(workflowsDir)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    return [];
  }
  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    for (const match of raw.matchAll(/run:\s*(.+)$/gm)) {
      const line = (match[1] as string).trim();
      if (!line || line.startsWith('#')) continue;
      commands.push({
        purpose: classifyCustomScript(line, line),
        command: line,
        cwd: dir,
        source: 'ci',
      });
    }
  }
  return commands;
}

export async function discoverPythonCommands(dir: string): Promise<DiscoveredCommand[]> {
  const manifests = await findPythonManifests(dir);
  if (manifests.length === 0) return [];
  const commands: DiscoveredCommand[] = [];

  const pyproject = manifests.find((m) => m.kind === 'pyproject');
  if (pyproject) {
    if (pyprojectHasSection(pyproject.raw, 'tool.pytest.ini_options') || (await pathExists(join(dir, 'pytest.ini')))) {
      commands.push({ purpose: 'unit-test', command: 'pytest', cwd: dir, source: 'inferred' });
    }
    if (pyprojectHasSection(pyproject.raw, 'tool.ruff')) {
      commands.push({ purpose: 'lint', command: 'ruff check .', cwd: dir, source: 'inferred' });
    }
    if (pyprojectHasSection(pyproject.raw, 'tool.black')) {
      commands.push({ purpose: 'format', command: 'black --check .', cwd: dir, source: 'inferred' });
    }
    if (pyprojectHasSection(pyproject.raw, 'tool.mypy')) {
      commands.push({ purpose: 'typecheck', command: 'mypy .', cwd: dir, source: 'inferred' });
    }
    if (pyprojectHasSection(pyproject.raw, 'tool.poetry')) {
      commands.push({ purpose: 'install', command: 'poetry install', cwd: dir, source: 'inferred' });
    } else {
      commands.push({ purpose: 'install', command: 'pip install -e .', cwd: dir, source: 'inferred' });
    }
  } else if (manifests.some((m) => m.kind === 'requirements.txt')) {
    commands.push({
      purpose: 'install',
      command: 'pip install -r requirements.txt',
      cwd: dir,
      source: 'inferred',
    });
    if (await pathExists(join(dir, 'pytest.ini'))) {
      commands.push({ purpose: 'unit-test', command: 'pytest', cwd: dir, source: 'inferred' });
    }
  }

  return commands;
}

/**
 * Runs all discovery sources in priority order and keeps only the first command found per
 * purpose, matching the provenance-priority rule in the product spec: repository-config > CI >
 * task-runner/Makefile > package-script > Python config > framework conventions > inference.
 */
export async function discoverCommands(dir: string): Promise<DiscoveredCommand[]> {
  const bySourcePriority: DiscoveredCommand[][] = [
    await discoverCiCommands(dir),
    await discoverTaskRunnerCommands(dir),
    await discoverMakefileCommands(dir),
    await discoverPackageJsonCommands(dir),
    await discoverPythonCommands(dir),
  ];

  const seenPurposes = new Set<CommandPurpose>();
  const result: DiscoveredCommand[] = [];
  for (const group of bySourcePriority) {
    for (const command of group) {
      if (seenPurposes.has(command.purpose) && command.purpose !== 'custom') continue;
      seenPurposes.add(command.purpose);
      result.push(command);
    }
  }
  return result;
}
