import { initDataDir } from '@awb/config';
import { createReadOnlyDatabase } from '@awb/database';
import { queryMemory } from '@awb/repository-memory';
import type { RepositoryFact } from '@awb/domain';

/** A project-memory fact reduced to what the planner prompt needs — statement + why-to-trust it. */
export interface MemoryFactForContext {
  kind: RepositoryFact['kind'];
  statement: string;
  confidence: RepositoryFact['confidence'];
  sourcePaths: string[];
}

/**
 * Fetches the project-memory facts most useful to the NEXT implementation and shapes them for a
 * planner/builder `contextPayload.memory`. This is the read side of project memory:
 * without it, the accumulated `repository_facts` never reach a run and the `memoryTokens` bucket stays
 * 0. Read-only DB handle (single-writer invariant — the daemon owns writes). Bounded by `limit` so
 * memory injection can't itself become a large re-sent context cost (see docs/token-cost-measurement).
 *
 * Ranking favours the kinds an implementer needs first — pitfalls/risks/invariants (what will bite
 * you), then commands/testing (how to build/verify), then the rest — and prefers higher-confidence
 * facts. When `changedPaths` is known, path-proximate facts are preferred.
 */
export async function loadProjectMemoryForContext(
  repositoryId: string,
  options: { changedPaths?: string[]; limit?: number } = {},
): Promise<MemoryFactForContext[]> {
  const limit = options.limit ?? 20;
  const { layout } = initDataDir();
  const handle = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const facts = await queryMemory(handle.db, handle.sqlite, repositoryId, {
      sort: 'confidence',
      ...(options.changedPaths && options.changedPaths.length > 0 ? { changedPaths: options.changedPaths } : {}),
    });
    return facts
      .sort((a, b) => kindRank(b.kind) - kindRank(a.kind))
      .slice(0, limit)
      .map((f) => ({ kind: f.kind, statement: f.statement, confidence: f.confidence, sourcePaths: f.sourcePaths }));
  } finally {
    handle.sqlite.close();
  }
}

/** Implementer-usefulness ordering: what-will-bite-you first, then how-to-build, then background. */
function kindRank(kind: RepositoryFact['kind']): number {
  switch (kind) {
    case 'pitfall':
    case 'risk':
      return 5;
    case 'invariant':
      return 4;
    case 'command':
    case 'testing':
      return 3;
    case 'concept':
    case 'convention':
      return 2;
    default:
      return 1;
  }
}
