import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig, saveConfig, resolveLayout, WorkbenchConfigSchema, type WorkbenchConfig } from '@awb/config';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';

function requireConfig(): WorkbenchConfig {
  const layout = resolveLayout();
  if (!existsSync(layout.configFile)) {
    throw new Error('No config.yaml — run `awb init` first.');
  }
  return loadConfig(layout);
}

function getPath(config: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, config);
}

/** Coerces a string CLI value to boolean/number when it looks like one, else leaves it a string. */
function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function setPath(config: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor = config;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('View and modify configuration');

  config
    .command('list')
    .description('Print the full configuration')
    .action(() => {
      const current = requireConfig();
      if (outputOptions().json) emitJson(current);
      else printResult(JSON.stringify(current, null, 2));
    });

  config
    .command('get <key>')
    .description('Print a single configuration value (dotted path, e.g. network.allowGithub)')
    .action((key: string) => {
      const current = requireConfig() as unknown as Record<string, unknown>;
      const value = getPath(current, key);
      if (value === undefined) {
        printError(`No such config key: ${key}`);
        process.exitCode = 1;
        return;
      }
      if (outputOptions().json) emitJson({ [key]: value });
      else printResult(typeof value === 'object' ? JSON.stringify(value) : String(value));
    });

  config
    .command('set <key> <value>')
    .description('Set a configuration value (dotted path); validated before saving')
    .action((key: string, value: string) => {
      const layout = resolveLayout();
      const current = requireConfig() as unknown as Record<string, unknown>;
      setPath(current, key, coerce(value));
      const validated = WorkbenchConfigSchema.parse(current);
      saveConfig(layout, validated);
      if (outputOptions().json) emitJson({ [key]: getPath(validated as unknown as Record<string, unknown>, key) });
      else printInfo(`set ${key}`);
    });
}
