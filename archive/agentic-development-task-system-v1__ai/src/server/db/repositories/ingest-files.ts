import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

// Types will be created by another agent — see @shared/types
interface IngestFileRow {
  id: string;
  file_path: string;
  file_name: string;
  sha256: string;
  event_type: string | null;
  ingest_status: string;
  rejection_reason: string | null;
  processed_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertIngestFile(file: IngestFileRow): void {
  const stmt = db().prepare(`
    INSERT INTO ingest_files (
      id, file_path, file_name, sha256,
      event_type, ingest_status, rejection_reason, processed_at
    ) VALUES (
      @id, @file_path, @file_name, @sha256,
      @event_type, @ingest_status, @rejection_reason, @processed_at
    )
  `);
  stmt.run(file);
}

export function listIngestFiles(filter?: { status?: string }): IngestFileRow[] {
  if (filter?.status) {
    return db()
      .prepare(`SELECT * FROM ingest_files WHERE ingest_status = ? ORDER BY processed_at DESC`)
      .all(filter.status) as IngestFileRow[];
  }
  return db()
    .prepare(`SELECT * FROM ingest_files ORDER BY processed_at DESC`)
    .all() as IngestFileRow[];
}

export function findByFilePath(filePath: string): IngestFileRow | undefined {
  return db()
    .prepare(`SELECT * FROM ingest_files WHERE file_path = ?`)
    .get(filePath) as IngestFileRow | undefined;
}

export function findBySha256(hash: string): IngestFileRow[] {
  return db()
    .prepare(`SELECT * FROM ingest_files WHERE sha256 = ?`)
    .all(hash) as IngestFileRow[];
}
