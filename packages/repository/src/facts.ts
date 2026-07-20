import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryFact, RepositoryUnit } from '@awb/domain';
import { pathExists } from './manifests.js';

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

  return facts;
}
