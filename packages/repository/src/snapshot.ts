import { randomUUID } from 'node:crypto';
import type { RepositorySnapshot, ValidatedCommand, ServiceDefinition, QaSurface } from '@awb/domain';
import { discoverUnits } from './units.js';
import { discoverCommands } from './command-discovery.js';
import { extractFacts } from './facts.js';
import { getHeadSha } from './git.js';
import { pathExists } from './manifests.js';
import { join } from 'node:path';

/**
 * Command discovery may find more than one command for the same purpose from a single source
 * (e.g. two package.json scripts both look like lint commands). Those are surfaced with
 * status "ambiguous" rather than silently picking one, per the product spec's requirement not
 * to silently resolve ambiguity.
 */
export function markAmbiguousDuplicates(commands: ValidatedCommand[]): ValidatedCommand[] {
  const countByPurpose = new Map<string, number>();
  for (const command of commands) {
    countByPurpose.set(command.purpose, (countByPurpose.get(command.purpose) ?? 0) + 1);
  }
  return commands.map((command) => {
    const count = countByPurpose.get(command.purpose) ?? 0;
    if (count > 1 && command.status !== 'validated') {
      return { ...command, status: 'ambiguous' as const };
    }
    return command;
  });
}

async function discoverServicesAndQaSurfaces(
  rootDir: string,
  repositoryId: string,
  commands: ValidatedCommand[],
): Promise<{ services: ServiceDefinition[]; qaSurfaces: QaSurface[] }> {
  const services: ServiceDefinition[] = [];
  const qaSurfaces: QaSurface[] = [];

  const startCommand = commands.find((c) => c.purpose === 'start');
  const hasIndexHtml = await pathExists(join(rootDir, 'index.html'));
  const hasCliBin = await pathExists(join(rootDir, 'bin'));

  if (startCommand) {
    services.push({
      id: randomUUID(),
      repositoryId,
      name: 'default',
      kind: hasIndexHtml ? 'web' : 'http-api',
      startCommandId: startCommand.id,
    });
    qaSurfaces.push({
      id: randomUUID(),
      repositoryId,
      kind: hasIndexHtml ? 'browser' : 'http-api',
      entrypoint: startCommand.command,
    });
  }

  if (hasCliBin) {
    qaSurfaces.push({
      id: randomUUID(),
      repositoryId,
      kind: 'cli',
      entrypoint: 'bin/',
    });
  }

  return { services, qaSurfaces };
}

export interface BuildSnapshotOptions {
  rootDir: string;
  repositoryId: string;
  /**
   * Enterprise repos (e.g. Klaviyo's `fender`/`app`) always have an established frontend and
   * internal tooling. Skips command discovery (safe: runtime tiers in
   * `resolveStartCommandForWorktree` etc. already re-discover/infer independently at task time)
   * and short-circuits `hasExistingFrontend` to `true` without needing a `web` unit present.
   */
  isEnterpriseRepo?: boolean;
}

export async function buildRepositorySnapshot({
  rootDir,
  repositoryId,
  isEnterpriseRepo = false,
}: BuildSnapshotOptions): Promise<RepositorySnapshot> {
  const headSha = await getHeadSha(rootDir);
  const units = await discoverUnits(rootDir);
  const hasExistingFrontend = isEnterpriseRepo || units.some((u) => u.kind === 'web');

  let commandsWithAmbiguity: ValidatedCommand[] = [];
  if (!isEnterpriseRepo) {
    const discoveredRoots = units.length > 0 ? units.map((u) => join(rootDir, u.root)) : [rootDir];
    const discoveredCommands = (
      await Promise.all(discoveredRoots.map((dir) => discoverCommands(dir)))
    ).flat();

    const validatedCommands: ValidatedCommand[] = discoveredCommands.map((cmd) => ({
      id: randomUUID(),
      repositoryId,
      purpose: cmd.purpose,
      command: cmd.command,
      cwd: cmd.cwd,
      source: cmd.source,
      status: cmd.source === 'inferred' ? 'inferred' : 'declared',
    }));

    commandsWithAmbiguity = markAmbiguousDuplicates(validatedCommands);
  }

  const { services, qaSurfaces } = await discoverServicesAndQaSurfaces(
    rootDir,
    repositoryId,
    commandsWithAmbiguity,
  );

  const facts = await extractFacts(rootDir, repositoryId, headSha, units, commandsWithAmbiguity);

  return {
    id: randomUUID(),
    repositoryId,
    headSha,
    createdAt: new Date().toISOString(),
    units,
    commands: commandsWithAmbiguity,
    services,
    qaSurfaces,
    facts,
    hasExistingFrontend,
  };
}
