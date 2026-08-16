import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryFact, RepositoryFactKind, RepositoryUnit, ValidatedCommand } from '@awb/domain';
import { pathExists } from './manifests.js';

// Which command purposes become facts the planner should see, and under which fact kind. Test
// purposes are `testing`; everything else runnable (build/start/install/lint/format/typecheck) is
// `command`. Purposes absent here (custom, healthcheck) are omitted as prompt noise.
const COMMAND_FACT_KIND: Partial<Record<ValidatedCommand['purpose'], RepositoryFactKind>> = {
  'unit-test': 'testing',
  'integration-test': 'testing',
  build: 'command',
  start: 'command',
  install: 'command',
  lint: 'command',
  format: 'command',
  typecheck: 'command',
};

/** Maps a command's (absolute) cwd to a repo-relative path; `.` for the root. */
function relativizeCwd(cwd: string, rootDir: string): string {
  if (!cwd || cwd === rootDir) return '.';
  if (cwd.startsWith(rootDir + '/')) return cwd.slice(rootDir.length + 1);
  return cwd; // already relative (or outside root) — leave as-is
}

async function sha256OfFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path);
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Extracts declared/inferred facts from repository-authored documentation and structure.
 * Facts are always tied to sourcePaths + sourceHashes so they can be invalidated later
 * (see @awb/repository-memory) when those paths change.
 */
export async function extractFacts(
  rootDir: string,
  repositoryId: string,
  headSha: string,
  units: RepositoryUnit[],
  commands: ValidatedCommand[] = [],
): Promise<RepositoryFact[]> {
  const facts: RepositoryFact[] = [];

  for (const docFile of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'ARCHITECTURE.md']) {
    const path = join(rootDir, docFile);
    if (!(await pathExists(path))) continue;
    const hash = await sha256OfFile(path);
    facts.push({
      id: randomUUID(),
      repositoryId,
      kind: docFile === 'README.md' ? 'convention' : 'architecture',
      statement: `Repository provides ${docFile} with agent/architecture guidance.`,
      confidence: 'declared',
      observedAtSha: headSha,
      sourcePaths: [docFile],
      sourceHashes: hash ? [hash] : [],
      invalidatedByPaths: [],
    });
  }

  const adrDir = join(rootDir, 'docs', 'adr');
  if (await pathExists(adrDir)) {
    facts.push({
      id: randomUUID(),
      repositoryId,
      kind: 'architecture',
      statement: 'Repository records architecture decisions under docs/adr.',
      confidence: 'declared',
      observedAtSha: headSha,
      sourcePaths: ['docs/adr'],
      sourceHashes: [],
      invalidatedByPaths: [],
    });
  }

  for (const unit of units) {
    facts.push({
      id: randomUUID(),
      repositoryId,
      kind: 'architecture',
      statement: `Unit at ${unit.root || '.'} is a ${unit.language} ${unit.kind}${unit.framework ? ` using ${unit.framework}` : ''}.`,
      confidence: 'inferred',
      observedAtSha: headSha,
      sourcePaths: unit.root ? [unit.root] : ['.'],
      sourceHashes: [],
      invalidatedByPaths: [],
    });
  }

  // Turn discovered/persisted runnable commands into facts so the planner — which is told to "prefer
  // the recorded commands over guessing" — actually sees how to build/test/run this repo through
  // project memory. Skip ambiguous/obsolete/failed rows (not something to hand a planner as truth).
  for (const command of commands) {
    const kind = COMMAND_FACT_KIND[command.purpose];
    if (!kind) continue;
    if (command.status === 'ambiguous' || command.status === 'obsolete' || command.status === 'failed') continue;
    // Command cwd is discovered as an absolute path; keep facts repo-relative like the doc/unit facts.
    const relCwd = relativizeCwd(command.cwd, rootDir);
    const where = relCwd !== '.' ? ` (cwd ${relCwd})` : '';
    facts.push({
      id: randomUUID(),
      repositoryId,
      kind,
      statement: `To ${command.purpose} this repository, run: \`${command.command}\`${where}.`,
      // A command proven to run (validated) is a validated fact; otherwise it is inferred/declared.
      confidence: command.status === 'validated' ? 'validated' : 'inferred',
      observedAtSha: headSha,
      sourcePaths: [relCwd],
      sourceHashes: [],
      invalidatedByPaths: [],
    });
  }

  return facts;
}
