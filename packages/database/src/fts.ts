import type Database from 'better-sqlite3';

export interface RepositoryFactSearchResult {
  id: string;
  repositoryId: string;
  statement: string;
  rank: number;
}

export function searchRepositoryFacts(
  sqlite: Database.Database,
  repositoryId: string,
  query: string,
  limit = 20,
): RepositoryFactSearchResult[] {
  return sqlite
    .prepare(
      `
      SELECT f.id AS id, f.repository_id AS repositoryId, f.statement AS statement, fts.rank AS rank
      FROM repository_facts_fts fts
      JOIN repository_facts f ON f.rowid = fts.rowid
      WHERE fts.statement MATCH ? AND f.repository_id = ?
      ORDER BY fts.rank
      LIMIT ?
      `,
    )
    .all(query, repositoryId, limit) as RepositoryFactSearchResult[];
}

export interface RepositorySymbolSearchResult {
  id: string;
  repositoryId: string;
  name: string;
  signature: string | null;
  rank: number;
}

export function searchRepositorySymbols(
  sqlite: Database.Database,
  repositoryId: string,
  query: string,
  limit = 20,
): RepositorySymbolSearchResult[] {
  return sqlite
    .prepare(
      `
      SELECT s.id AS id, s.repository_id AS repositoryId, s.name AS name, s.signature AS signature, fts.rank AS rank
      FROM repository_symbols_fts fts
      JOIN repository_symbols s ON s.rowid = fts.rowid
      WHERE repository_symbols_fts MATCH ? AND s.repository_id = ?
      ORDER BY fts.rank
      LIMIT ?
      `,
    )
    .all(query, repositoryId, limit) as RepositorySymbolSearchResult[];
}

export interface TaskContractSearchResult {
  id: string;
  taskId: string;
  objective: string;
  rank: number;
}

export function searchTaskContracts(
  sqlite: Database.Database,
  taskId: string,
  query: string,
  limit = 20,
): TaskContractSearchResult[] {
  return sqlite
    .prepare(
      `
      SELECT c.id AS id, c.task_id AS taskId, c.objective AS objective, fts.rank AS rank
      FROM task_contracts_fts fts
      JOIN task_contracts c ON c.rowid = fts.rowid
      WHERE task_contracts_fts MATCH ? AND c.task_id = ?
      ORDER BY fts.rank
      LIMIT ?
      `,
    )
    .all(query, taskId, limit) as TaskContractSearchResult[];
}

export interface FindingSearchResult {
  id: string;
  taskId: string;
  description: string;
  rank: number;
}

export function searchFindings(
  sqlite: Database.Database,
  taskId: string,
  query: string,
  limit = 20,
): FindingSearchResult[] {
  return sqlite
    .prepare(
      `
      SELECT f.id AS id, f.task_id AS taskId, f.description AS description, fts.rank AS rank
      FROM findings_fts fts
      JOIN findings f ON f.rowid = fts.rowid
      WHERE findings_fts MATCH ? AND f.task_id = ?
      ORDER BY fts.rank
      LIMIT ?
      `,
    )
    .all(query, taskId, limit) as FindingSearchResult[];
}

export interface MemoryEntrySearchResult {
  id: string;
  repositoryId: string | null;
  title: string;
  rank: number;
}

export function searchMemoryEntries(
  sqlite: Database.Database,
  query: string,
  limit = 20,
): MemoryEntrySearchResult[] {
  return sqlite
    .prepare(
      `
      SELECT m.id AS id, m.repository_id AS repositoryId, m.title AS title, fts.rank AS rank
      FROM memory_entries_fts fts
      JOIN memory_entries m ON m.rowid = fts.rowid
      WHERE memory_entries_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
      `,
    )
    .all(query, limit) as MemoryEntrySearchResult[];
}
