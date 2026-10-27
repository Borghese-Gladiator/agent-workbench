import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

export interface CommentRow {
  id: string;
  work_item_id: string;
  body: string;
  author_type: "user" | "agent" | "system";
  author_id: string | null;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

function db(): Database.Database {
  return getDb();
}

export function insertComment(comment: CommentRow): void {
  db().prepare(`
    INSERT INTO comments (
      id, work_item_id, body, author_type, author_id,
      created_at, updated_at, edited_at
    ) VALUES (
      @id, @work_item_id, @body, @author_type, @author_id,
      @created_at, @updated_at, @edited_at
    )
  `).run(comment);
}

export function listCommentsForWorkItem(workItemId: string): CommentRow[] {
  return db()
    .prepare(`SELECT * FROM comments WHERE work_item_id = ? ORDER BY created_at ASC`)
    .all(workItemId) as CommentRow[];
}

export function getCommentById(id: string): CommentRow | undefined {
  return db()
    .prepare(`SELECT * FROM comments WHERE id = ?`)
    .get(id) as CommentRow | undefined;
}

export function updateCommentBody(id: string, body: string, now: string): void {
  db()
    .prepare(`UPDATE comments SET body = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
    .run(body, now, now, id);
}

export function deleteComment(id: string): void {
  db().prepare(`DELETE FROM comments WHERE id = ?`).run(id);
}
