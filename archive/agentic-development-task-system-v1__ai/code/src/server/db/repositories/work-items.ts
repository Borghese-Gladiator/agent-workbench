import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface WorkItemRow {
  id: string;
  epic_id: string | null;
  parent_id: string | null;
  slug: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  category: string;
  awaiting_input: number;
  active_session_id: string | null;
  assigned_agent_id: string | null;
  reviewer_agent_id: string | null;
  branch_name: string | null;
  acceptance_criteria: string | null;
  result_summary: string | null;
  sort_order: number;
  lane: string | null;
  batch_id: string | null;
  depends_on_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

export interface WorkItemListRow extends WorkItemRow {
  ready_to_start: number;
  blocked_by_title: string | null;
}

interface WorkItemFilter {
  status?: string;
  kind?: string;
  epicId?: string;
  parentId?: string | null;
  assignedAgentId?: string;
  tag?: string;
  category?: string;
  lane?: string;
  batchId?: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertWorkItem(item: WorkItemRow): void {
  db().prepare(`
    INSERT INTO work_items (
      id, epic_id, parent_id, slug, kind, title, body, status,
      category, awaiting_input, active_session_id,
      assigned_agent_id, reviewer_agent_id, branch_name,
      acceptance_criteria, result_summary, sort_order,
      lane, batch_id, depends_on_id,
      created_by, created_at, updated_at, completed_at, archived_at
    ) VALUES (
      @id, @epic_id, @parent_id, @slug, @kind, @title, @body, @status,
      @category, @awaiting_input, @active_session_id,
      @assigned_agent_id, @reviewer_agent_id, @branch_name,
      @acceptance_criteria, @result_summary, @sort_order,
      @lane, @batch_id, @depends_on_id,
      @created_by, @created_at, @updated_at, @completed_at, @archived_at
    )
  `).run(item);
}

export function getWorkItemById(id: string): WorkItemRow | undefined {
  return db().prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItemRow | undefined;
}

export function listWorkItems(filter?: WorkItemFilter): WorkItemListRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let join = "";

  if (filter?.status) {
    conditions.push("w.status = ?");
    params.push(filter.status);
  }
  if (filter?.kind) {
    conditions.push("w.kind = ?");
    params.push(filter.kind);
  }
  if (filter?.epicId) {
    conditions.push("w.epic_id = ?");
    params.push(filter.epicId);
  }
  if (filter?.parentId !== undefined) {
    if (filter.parentId === null) {
      conditions.push("w.parent_id IS NULL");
    } else {
      conditions.push("w.parent_id = ?");
      params.push(filter.parentId);
    }
  }
  if (filter?.assignedAgentId) {
    conditions.push("w.assigned_agent_id = ?");
    params.push(filter.assignedAgentId);
  }
  if (filter?.category) {
    conditions.push("w.category = ?");
    params.push(filter.category);
  }
  if (filter?.lane) {
    conditions.push("w.lane = ?");
    params.push(filter.lane);
  }
  if (filter?.batchId) {
    conditions.push("w.batch_id = ?");
    params.push(filter.batchId);
  }
  if (filter?.tag) {
    join = "JOIN work_item_tags wt ON wt.work_item_id = w.id";
    conditions.push("wt.tag = ?");
    params.push(filter.tag);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db()
    .prepare(
      `SELECT w.*,
        CASE
          WHEN w.status NOT IN ('triage','ready') THEN 0
          WHEN w.depends_on_id IS NULL THEN 1
          WHEN EXISTS (
            SELECT 1 FROM work_items p
            WHERE p.id = w.depends_on_id AND p.status = 'done'
          ) THEN 1
          ELSE 0
        END AS ready_to_start,
        (SELECT p.title FROM work_items p WHERE p.id = w.depends_on_id) AS blocked_by_title
      FROM work_items w
      ${join}
      ${where}
      ORDER BY w.sort_order ASC, w.created_at ASC, w.id ASC`,
    )
    .all(...params) as WorkItemListRow[];
}

export function updateWorkItem(id: string, updates: Partial<Omit<WorkItemRow, "id" | "created_at">>): void {
  const now = new Date().toISOString();
  const fields = Object.keys(updates).filter((k) => k !== "updated_at");
  if (fields.length === 0) return;

  const setClauses = [...fields.map((f) => `${f} = @${f}`), "updated_at = @updated_at"];
  db().prepare(`UPDATE work_items SET ${setClauses.join(", ")} WHERE id = @id`).run({ ...updates, updated_at: now, id });
}

export function updateWorkItemStatus(id: string, status: string): void {
  const now = new Date().toISOString();
  const completedAt = status === "done" ? now : null;
  db().prepare(`UPDATE work_items SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`).run(status, now, completedAt, id);
}

export function reorderWorkItems(items: { work_item_id: string; sort_order: number }[]): void {
  const stmt = db().prepare(`UPDATE work_items SET sort_order = ? WHERE id = ?`);
  const transaction = db().transaction((entries: { work_item_id: string; sort_order: number }[]) => {
    for (const entry of entries) {
      stmt.run(entry.sort_order, entry.work_item_id);
    }
  });
  transaction(items);
}

export function getSubItems(parentId: string): WorkItemRow[] {
  return db().prepare(`SELECT * FROM work_items WHERE parent_id = ? ORDER BY sort_order, created_at`).all(parentId) as WorkItemRow[];
}

export function deleteWorkItem(id: string): void {
  db().prepare(`DELETE FROM work_items WHERE id = ?`).run(id);
}
