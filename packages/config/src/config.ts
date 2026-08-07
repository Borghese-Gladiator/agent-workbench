import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { DataDirLayout } from './paths.js';

export const WorkbenchConfigSchema = z.object({
  version: z.number().int().default(1),
  agentProvider: z.enum(['mock', 'claude']).default('mock'),
  network: z
    .object({
      allowLocalhost: z.boolean().default(true),
      allowGithub: z.boolean().default(true),
    })
    .default({ allowLocalhost: true, allowGithub: true }),
});
export type WorkbenchConfig = z.infer<typeof WorkbenchConfigSchema>;

export function loadConfig(layout: DataDirLayout): WorkbenchConfig {
  const raw = readFileSync(layout.configFile, 'utf8');
  const parsed = parse(raw) ?? {};
  return WorkbenchConfigSchema.parse(parsed);
}

export function saveConfig(layout: DataDirLayout, config: WorkbenchConfig): void {
  writeFileSync(layout.configFile, stringify(config), 'utf8');
}
