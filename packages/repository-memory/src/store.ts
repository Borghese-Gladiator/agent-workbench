import type { RepositoryFact } from '@awb/domain';
import { repositoryFacts, repositoryFactSources, type DrizzleDb } from '@awb/database';

/**
 * Persists a batch of repository facts with full provenance.
 *
 * Each fact is inserted into `repository_facts` (array fields JSON-serialized per the
 * existing column shape) plus one `repository_fact_sources` row per source path, so the
 * join table stays the authoritative per-path provenance log even though `repository_facts`
 * also carries a denormalized `source_paths_json` for fast in-row filtering.
 */
export async function recordFacts(
  db: DrizzleDb,
  repositoryId: string,
  facts: RepositoryFact[],
): Promise<void> {
  for (const fact of facts) {
    if (fact.repositoryId !== repositoryId) {
      throw new Error(
        `recordFacts: fact ${fact.id} has repositoryId ${fact.repositoryId}, expected ${repositoryId}`,
      );
    }

    await db.insert(repositoryFacts).values({
      id: fact.id,
      repositoryId: fact.repositoryId,
      kind: fact.kind,
      statement: fact.statement,
      confidence: fact.confidence,
      observedAtSha: fact.observedAtSha,
      sourcePathsJson: JSON.stringify(fact.sourcePaths),
      sourceHashesJson: JSON.stringify(fact.sourceHashes),
      invalidatedByPathsJson: JSON.stringify(fact.invalidatedByPaths),
      supersededBy: fact.supersededBy ?? null,
    });

    if (fact.sourcePaths.length > 0) {
      await db.insert(repositoryFactSources).values(
        fact.sourcePaths.map((path, index) => ({
          factId: fact.id,
          path,
          sha256: fact.sourceHashes[index] ?? null,
        })),
      );
    }
  }
}
