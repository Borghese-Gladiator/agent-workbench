import type Database from 'better-sqlite3';
import { and, eq, isNull } from 'drizzle-orm';
import {
  repositoryFacts,
  searchRepositoryFacts,
  type DrizzleDb,
  type RepositoryFactRow,
} from '@awb/database';
import type { RepositoryFact, RepositoryFactConfidence } from '@awb/domain';

export type MemorySort = 'recency' | 'confidence';

/**
 * Options covering the retrieval modes this package supports:
 *  - `path`: facts whose sourcePaths include this exact path.
 *  - `unitPrefix`: facts scoped under a project unit root (sourcePaths starting with the prefix).
 *  - `changedPaths`: facts whose sourcePaths share a directory prefix with any of these paths
 *    ("changed-path proximity" — a fact "touches" a changed path if one is a prefix of the
 *    other's containing directory, so a changed file under `src/auth/` surfaces facts sourced
 *    from `src/auth/login.ts` and vice versa).
 *  - `text`: delegates to `@awb/database`'s FTS5 `searchRepositoryFacts` helper, then the
 *    remaining filters/sort are applied to that result set.
 *  - `confidence`: restrict to one or more confidence levels.
 *  - `includeInvalidated`: by default, invalidated facts (supersededBy set) are excluded.
 *  - `sort`: 'recency' (rowid/insertion order, descending) or 'confidence'
 *    (validated > declared > inferred).
 *
 * Symbol-name lookup is intentionally NOT implemented here: this package doesn't own a symbol
 * index (that's `repository_symbols` / `@awb/repository-map`'s domain). `symbolLookup` is a
 * pass-through hook — if provided, its result paths are unioned into the path/proximity
 * filtering so a symbol-name query can compose with this package's fact store once a symbol
 * index is wired up by the caller.
 */
export interface MemoryQuery {
  path?: string;
  unitPrefix?: string;
  changedPaths?: string[];
  text?: string;
  confidence?: RepositoryFactConfidence[];
  includeInvalidated?: boolean;
  sort?: MemorySort;
  limit?: number;
  symbolLookup?: (name: string) => string[];
  symbolName?: string;
}

function rowToFact(row: RepositoryFactRow): RepositoryFact {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    kind: row.kind,
    statement: row.statement,
    confidence: row.confidence,
    observedAtSha: row.observedAtSha,
    sourcePaths: JSON.parse(row.sourcePathsJson) as string[],
    sourceHashes: JSON.parse(row.sourceHashesJson) as string[],
    invalidatedByPaths: JSON.parse(row.invalidatedByPathsJson) as string[],
    supersededBy: row.supersededBy ?? undefined,
  };
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function sharesDirectoryPrefix(sourcePath: string, changedPath: string): boolean {
  if (sourcePath === changedPath) return true;
  const sourceDir = dirOf(sourcePath);
  const changedDir = dirOf(changedPath);
  return (
    sourceDir === changedDir ||
    sourceDir.startsWith(`${changedDir}/`) ||
    changedDir.startsWith(`${sourceDir}/`)
  );
}

const CONFIDENCE_RANK: Record<RepositoryFactConfidence, number> = {
  validated: 2,
  declared: 1,
  inferred: 0,
};

/**
 * Retrieves repository facts matching the given filters. All filters are applied as an AND —
 * pass only the ones you need. `text` delegates matching (not just ranking) to FTS5.
 */
export async function queryMemory(
  db: DrizzleDb,
  sqlite: Database.Database,
  repositoryId: string,
  query: MemoryQuery = {},
): Promise<RepositoryFact[]> {
  let candidateIds: Set<string> | undefined;

  if (query.text !== undefined) {
    const hits = searchRepositoryFacts(sqlite, repositoryId, query.text, query.limit ?? 20);
    candidateIds = new Set(hits.map((hit) => hit.id));
  }

  const whereClauses = [eq(repositoryFacts.repositoryId, repositoryId)];
  if (!query.includeInvalidated) {
    whereClauses.push(isNull(repositoryFacts.supersededBy));
  }

  const rows: RepositoryFactRow[] = await db
    .select()
    .from(repositoryFacts)
    .where(and(...whereClauses));

  let facts = rows.map(rowToFact);

  if (candidateIds) {
    const ids = candidateIds;
    facts = facts.filter((fact) => ids.has(fact.id));
  }

  if (query.path !== undefined) {
    const path = query.path;
    facts = facts.filter((fact) => fact.sourcePaths.includes(path));
  }

  if (query.unitPrefix !== undefined) {
    const prefix = query.unitPrefix;
    facts = facts.filter((fact) => fact.sourcePaths.some((p) => p.startsWith(prefix)));
  }

  const symbolPaths = query.symbolName && query.symbolLookup ? query.symbolLookup(query.symbolName) : undefined;
  if (symbolPaths !== undefined) {
    const symbolPathSet = new Set(symbolPaths);
    facts = facts.filter((fact) => fact.sourcePaths.some((p) => symbolPathSet.has(p)));
  }

  if (query.changedPaths !== undefined && query.changedPaths.length > 0) {
    const changedPaths = query.changedPaths;
    facts = facts.filter((fact) =>
      fact.sourcePaths.some((sourcePath) =>
        changedPaths.some((changedPath) => sharesDirectoryPrefix(sourcePath, changedPath)),
      ),
    );
  }

  if (query.confidence !== undefined && query.confidence.length > 0) {
    const allowed = new Set(query.confidence);
    facts = facts.filter((fact) => allowed.has(fact.confidence));
  }

  if (query.sort === 'confidence') {
    facts = [...facts].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
  } else if (query.sort === 'recency') {
    facts = [...facts].reverse();
  }

  if (query.limit !== undefined) {
    facts = facts.slice(0, query.limit);
  }

  return facts;
}
