import type { RepositoryFact } from '@awb/domain';
import { repositoryFacts, repositoryFactSources, type DrizzleDb } from '@awb/database';
import { qualifiesForPromotion, evictSupersededFacts, type EvictionResult } from './lifecycle.js';

export interface RecordFactsResult {
  /** Ids actually written. */
  recorded: string[];
  /** Facts the promotion rule refused, with why — so a caller can log what it dropped. */
  rejected: { factId: string; reasons: string[] }[];
  /** What the eviction pass superseded as a consequence of this write. */
  evicted: EvictionResult;
}

/**
 * Persists a batch of repository facts with full provenance, applying the memory lifecycle
 * (ADR-010): the promotion rule gates every write, and a successful write runs the eviction pass
 * so a fact this batch replaces stops being served to the next planner.
 *
 * Each promoted fact is inserted into `repository_facts` (array fields JSON-serialized per the
 * existing column shape) plus one `repository_fact_sources` row per source path, so the
 * join table stays the authoritative per-path provenance log even though `repository_facts`
 * also carries a denormalized `source_paths_json` for fast in-row filtering.
 *
 * Promotion is a GATE, not a suggestion. Before ADR-010 the store only ever grew, because any
 * fact a run produced could be written and nothing said which were worth keeping.
 */
export async function recordFacts(
  db: DrizzleDb,
  repositoryId: string,
  facts: (RepositoryFact & { supersedesFactIds?: string[] })[],
  options: { observationsSinceByFactId?: Map<string, number> } = {},
): Promise<RecordFactsResult> {
  const result: RecordFactsResult = { recorded: [], rejected: [], evicted: { replaced: [], stale: [] } };
  const promoted: { id: string; supersedesFactIds?: string[] }[] = [];

  for (const fact of facts) {
    if (fact.repositoryId !== repositoryId) {
      throw new Error(
        `recordFacts: fact ${fact.id} has repositoryId ${fact.repositoryId}, expected ${repositoryId}`,
      );
    }

    // A mismatched repositoryId is a programming error and still throws. A fact that simply does
    // not earn a row is not an error — it is the policy working, so it is reported, not raised.
    const verdict = qualifiesForPromotion(fact);
    if (!verdict.promote) {
      result.rejected.push({ factId: fact.id, reasons: verdict.reasons });
      continue;
    }
    promoted.push({ id: fact.id, ...(fact.supersedesFactIds ? { supersedesFactIds: fact.supersedesFactIds } : {}) });

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
    result.recorded.push(fact.id);
  }

  // Eviction runs AFTER the inserts so a superseding fact already exists to point at.
  if (promoted.length > 0) {
    result.evicted = await evictSupersededFacts(db, repositoryId, promoted, options);
  }
  return result;
}
