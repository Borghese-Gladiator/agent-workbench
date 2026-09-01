import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolveLayout, type DataDirLayout } from './paths.js';
import { loadConfig } from './config.js';

export function ensureDataDir(layout: DataDirLayout = resolveLayout()): DataDirLayout {
  const dirs = [
    layout.root,
    layout.temporalDir,
    layout.databaseDir,
    layout.artifactsDir,
    layout.cacheDir,
    layout.cacheRepositoriesDir,
    layout.cacheVideoDir,
    layout.cacheTemporaryContextDir,
    layout.repositoriesDir,
    layout.worktreesDir,
    layout.runtimeDir,
    layout.runtimePortsDir,
    layout.runtimePidsDir,
    layout.runtimeSocketsDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(layout.configFile)) {
    writeFileSync(layout.configFile, defaultConfigYaml(), 'utf8');
  }
  return layout;
}

function defaultConfigYaml(): string {
  return [
    '# Agentic Workbench configuration',
    'version: 1',
    'agentProvider: mock',
    'network:',
    '  allowLocalhost: true',
    '  allowGithub: true',
    'planning:',
    '  disableProgramDesign: false',
    '',
  ].join('\n');
}

export function initDataDir(): { layout: DataDirLayout; created: boolean } {
  const layout = resolveLayout();
  const created = !existsSync(layout.root);
  ensureDataDir(layout);
  loadConfig(layout);
  return { layout, created };
}
