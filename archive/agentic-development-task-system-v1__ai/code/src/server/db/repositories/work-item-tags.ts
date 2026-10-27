import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

function db(): Database.Database {
  return getDb();
}

export function insertTags(workItemId: string, tags: string[]): void {
  if (tags.length === 0) return;

  const stmt = db().prepare(
    `INSERT OR IGNORE INTO work_item_tags (work_item_id, tag) VALUES (?, ?)`
  );

  const insertAll = db().transaction(() => {
    for (const tag of tags) {
      stmt.run(workItemId, tag);
    }
  });

  insertAll();
}

export function getTagsForWorkItem(workItemId: string): string[] {
  const rows = db()
    .prepare(`SELECT tag FROM work_item_tags WHERE work_item_id = ? ORDER BY tag`)
    .all(workItemId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

export function getAllUniqueTags(): string[] {
  const rows = db()
    .prepare(`SELECT DISTINCT tag FROM work_item_tags ORDER BY tag`)
    .all() as { tag: string }[];
  return rows.map((r) => r.tag);
}

export function replaceTagsForWorkItem(workItemId: string, tags: string[]): void {
  const deleteStmt = db().prepare(`DELETE FROM work_item_tags WHERE work_item_id = ?`);
  const insertStmt = db().prepare(
    `INSERT OR IGNORE INTO work_item_tags (work_item_id, tag) VALUES (?, ?)`
  );
  const tx = db().transaction(() => {
    deleteStmt.run(workItemId);
    for (const tag of tags) {
      const trimmed = tag.trim();
      if (trimmed.length > 0) insertStmt.run(workItemId, trimmed);
    }
  });
  tx();
}
