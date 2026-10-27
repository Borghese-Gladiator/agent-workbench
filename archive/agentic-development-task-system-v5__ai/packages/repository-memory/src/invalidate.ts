import { and, eq, isNull } from 'drizzle-orm';
import { repositoryFacts, type DrizzleDb, type RepositoryFactRow } from '@awb/database';

/**
 * Invalidation mechanism: soft-delete via the pre-existing `supersededBy` column.
 *
 * Rather than deleting rows or adding a new "invalid" flag, an invalidated fact simply gets
 * `supersededBy` set to a sentinel (`INVALIDATED_MARKER`). This reuses the column the schema
 * already ships with, keeps invalidated facts queryable for history/debugging, and makes
 * "is this fact still live" a single `supersededBy IS NULL` check — the same check
 * `queryMemory` uses by default. Facts are never removed by this function.
 */
export const INVALIDATED_MARKER = 'invalidated';

function overlaps(paths: string[], changedPaths: Set<string>): boolean {
  return paths.some((path) => changedPaths.has(path));
}

/**
 * Marks facts as invalid when their `sourcePaths` OR `invalidatedByPaths` overlap the given
 * set of changed paths. Facts with no overlap in either field are left untouched. Returns the
 * ids of facts that were newly invalidated.
 */
export async function invalidateFacts(
  db: DrizzleDb,
  repositoryId: string,
  changedPaths: string[],
): Promise<string[]> {
  const changedSet = new Set(changedPaths);
  if (changedSet.size === 0) {
    return [];
  }

  const rows: RepositoryFactRow[] = await db
    .select()
    .from(repositoryFacts)
    .where(and(eq(repositoryFacts.repositoryId, repositoryId), isNull(repositoryFacts.supersededBy)));

  const invalidatedIds: string[] = [];

  for (const row of rows) {
    const sourcePaths = JSON.parse(row.sourcePathsJson) as string[];
    const invalidatedByPaths = JSON.parse(row.invalidatedByPathsJson) as string[];

    if (overlaps(sourcePaths, changedSet) || overlaps(invalidatedByPaths, changedSet)) {
      await db
        .update(repositoryFacts)
        .set({ supersededBy: INVALIDATED_MARKER })
        .where(eq(repositoryFacts.id, row.id));
      invalidatedIds.push(row.id);
    }
  }

  return invalidatedIds;
}
