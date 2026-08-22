import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { DataDirLayout } from './paths.js';

export const WorkbenchConfigSchema = z.object({
  version: z.number().int().default(1),
  // Keep in sync with AGENT_RUNTIMES in @awb/agent-gateway (the source of truth). Not imported from
  // there because config is a foundational leaf (config → domain only); a backwards edge to the
  // heavier agent-gateway would invert the dependency layering (docs/dependencies.md).
  agentProvider: z.enum(['mock', 'claude', 'codex', 'pi', 'opencode']).default('mock'),
  network: z
    .object({
      allowLocalhost: z.boolean().default(true),
      allowGithub: z.boolean().default(true),
    })
    .default({ allowLocalhost: true, allowGithub: true }),
  /**
   * Canonical-path prefixes that mark a registered repository as enterprise (see
   * `Repository.isEnterpriseRepo`). Matched at registration time; e.g. `["~/Klaviyo/Repos"]`.
   */
  enterpriseRepoRoots: z.array(z.string()).default([]),
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
