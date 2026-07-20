import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface ArtifactRow {
  id: string;
  work_item_id: string | null;
  epic_id: string | null;
  session_id: string | null;
  artifact_type: string;
  title: string | null;
  path: string | null;
  mime_type: string | null;
  metadata_json: string | null;
  created_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertArtifact(artifact: ArtifactRow): void {
  db().prepare(`
    INSERT INTO artifacts (
      id, work_item_id, epic_id, session_id,
      artifact_type, title, path, mime_type,
      metadata_json, created_at
    ) VALUES (
      @id, @work_item_id, @epic_id, @session_id,
      @artifact_type, @title, @path, @mime_type,
      @metadata_json, @created_at
    )
  `).run(artifact);
}

export function getArtifactsForWorkItem(workItemId: string): ArtifactRow[] {
  return db()
    .prepare(`SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at DESC`)
    .all(workItemId) as ArtifactRow[];
}

export function getArtifactsForEpic(epicId: string): ArtifactRow[] {
  return db()
    .prepare(`SELECT * FROM artifacts WHERE epic_id = ? ORDER BY created_at DESC`)
    .all(epicId) as ArtifactRow[];
}

export function getArtifactById(id: string): ArtifactRow | undefined {
  return db()
    .prepare(`SELECT * FROM artifacts WHERE id = ?`)
    .get(id) as ArtifactRow | undefined;
}
