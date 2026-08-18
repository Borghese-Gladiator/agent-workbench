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
  // Planning-shape knobs. `disableProgramDesign` drops the separate program-design phase from an
  // L run's phase set so an A/B run can compare program-design vs no-program-design (rework/loop-back
  // and reviewed-vs-total ratio). Off by default — the full L ceremony is unchanged.
  planning: z
    .object({
      disableProgramDesign: z.boolean().default(false),
    })
    .default({ disableProgramDesign: false }),
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

/**
 * The planning-shape config for the current data dir, with defaults applied. Read at workflow-start
 * (TASK-61) so the deterministic workflow receives `disableProgramDesign` as an input rather than
 * reading config live. Falls back to the schema defaults when no config file exists yet.
 */
export function resolvePlanningConfig(layout: DataDirLayout): WorkbenchConfig['planning'] {
  try {
    return loadConfig(layout).planning;
  } catch {
    return WorkbenchConfigSchema.parse({}).planning;
  }
}
