import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface SessionLinkRow {
  id: string;
  work_item_id: string;
  session_id: string;
  role: string;
  created_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertLink(link: SessionLinkRow): void {
  db().prepare(`
    INSERT INTO task_session_links (id, work_item_id, session_id, role, created_at)
    VALUES (@id, @work_item_id, @session_id, @role, @created_at)
  `).run(link);
}

export function getLinksForWorkItem(workItemId: string): SessionLinkRow[] {
  return db()
    .prepare(`SELECT * FROM task_session_links WHERE work_item_id = ? ORDER BY created_at`)
    .all(workItemId) as SessionLinkRow[];
}

export function getLinksForSession(sessionId: string): SessionLinkRow[] {
  return db()
    .prepare(`SELECT * FROM task_session_links WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as SessionLinkRow[];
}
