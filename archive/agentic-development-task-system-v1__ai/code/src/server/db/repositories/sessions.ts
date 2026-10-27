import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface SessionRow {
  id: string;
  title: string;
  state: string;
  tmux_session_name: string | null;
  cwd: string | null;
  branch_name: string | null;
  primary_work_item_id: string | null;
  started_at: string;
  last_seen_at: string | null;
  exited_at: string | null;
  exit_code: number | null;
  metadata_json: string | null;
  claude_session_id: string | null;
}

export interface SessionListRow extends SessionRow {
  work_item_title: string | null;
}

interface SessionFilter {
  state?: string;
  primaryWorkItemId?: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertSession(session: SessionRow): void {
  db().prepare(`
    INSERT INTO terminal_sessions (
      id, title, state, tmux_session_name, cwd, branch_name,
      primary_work_item_id, started_at, last_seen_at, exited_at,
      exit_code, metadata_json, claude_session_id
    ) VALUES (
      @id, @title, @state, @tmux_session_name, @cwd, @branch_name,
      @primary_work_item_id, @started_at, @last_seen_at, @exited_at,
      @exit_code, @metadata_json, @claude_session_id
    )
  `).run(session);
}

export function getSessionById(id: string): SessionRow | undefined {
  return db().prepare(`SELECT * FROM terminal_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function listSessions(filter?: SessionFilter): SessionListRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.state) {
    conditions.push("s.state = ?");
    params.push(filter.state);
  }
  if (filter?.primaryWorkItemId) {
    conditions.push("s.primary_work_item_id = ?");
    params.push(filter.primaryWorkItemId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(`
    SELECT s.*, w.title AS work_item_title
    FROM terminal_sessions s
    LEFT JOIN work_items w ON w.id = s.primary_work_item_id
    ${where}
    ORDER BY s.started_at DESC
  `).all(...params) as SessionListRow[];
}

export function updateSession(id: string, updates: Partial<Omit<SessionRow, "id" | "started_at">>): void {
  const fields = Object.keys(updates);
  if (fields.length === 0) return;

  const setClauses = fields.map((f) => `${f} = @${f}`);
  db().prepare(`UPDATE terminal_sessions SET ${setClauses.join(", ")} WHERE id = @id`).run({ ...updates, id });
}
