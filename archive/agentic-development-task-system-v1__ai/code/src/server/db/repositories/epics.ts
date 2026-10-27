import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface EpicRow {
  id: string;
  initiative_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  color: string;
  sort_order: number;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpicWithCounts extends EpicRow {
  work_item_count: number;
  done_count: number;
}

function db(): Database.Database {
  return getDb();
}

export function insertEpic(epic: EpicRow): void {
  db().prepare(`
    INSERT INTO epics (id, initiative_id, slug, title, description, status, color, sort_order, batch_id, created_at, updated_at)
    VALUES (@id, @initiative_id, @slug, @title, @description, @status, @color, @sort_order, @batch_id, @created_at, @updated_at)
  `).run(epic);
}

export function getEpicById(id: string): EpicRow | undefined {
  return db().prepare(`SELECT * FROM epics WHERE id = ?`).get(id) as EpicRow | undefined;
}

export function listEpics(filter?: { initiativeId?: string; status?: string }): EpicRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.initiativeId) {
    conditions.push("initiative_id = ?");
    params.push(filter.initiativeId);
  }
  if (filter?.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(`SELECT * FROM epics ${where} ORDER BY sort_order, title`).all(...params) as EpicRow[];
}

export function listEpicsWithCounts(filter?: { initiativeId?: string; status?: string }): EpicWithCounts[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.initiativeId) {
    conditions.push("e.initiative_id = ?");
    params.push(filter.initiativeId);
  }
  if (filter?.status) {
    conditions.push("e.status = ?");
    params.push(filter.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(`
    SELECT e.*,
      COALESCE(counts.work_item_count, 0) as work_item_count,
      COALESCE(counts.done_count, 0) as done_count
    FROM epics e
    LEFT JOIN (
      SELECT epic_id,
        COUNT(*) as work_item_count,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count
      FROM work_items
      WHERE parent_id IS NULL
      GROUP BY epic_id
    ) counts ON counts.epic_id = e.id
    ${where}
    ORDER BY e.sort_order, e.title
  `).all(...params) as EpicWithCounts[];
}

export function updateEpic(id: string, updates: Partial<Omit<EpicRow, "id" | "created_at">>): void {
  const now = new Date().toISOString();
  const fields = Object.keys(updates).filter((k) => k !== "updated_at");
  if (fields.length === 0) return;

  const setClauses = [...fields.map((f) => `${f} = @${f}`), "updated_at = @updated_at"];
  db().prepare(`UPDATE epics SET ${setClauses.join(", ")} WHERE id = @id`).run({ ...updates, updated_at: now, id });
}

export function deleteEpic(id: string): void {
  db().prepare(`DELETE FROM epics WHERE id = ?`).run(id);
}
