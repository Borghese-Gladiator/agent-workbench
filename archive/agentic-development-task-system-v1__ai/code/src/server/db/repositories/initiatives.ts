import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface InitiativeRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertInitiative(initiative: InitiativeRow): void {
  db().prepare(`
    INSERT INTO initiatives (id, slug, name, description, status, sort_order, created_at, updated_at)
    VALUES (@id, @slug, @name, @description, @status, @sort_order, @created_at, @updated_at)
  `).run(initiative);
}

export function getInitiativeById(id: string): InitiativeRow | undefined {
  return db().prepare(`SELECT * FROM initiatives WHERE id = ?`).get(id) as InitiativeRow | undefined;
}

export function listInitiatives(): InitiativeRow[] {
  return db().prepare(`SELECT * FROM initiatives ORDER BY sort_order, name`).all() as InitiativeRow[];
}

export function updateInitiative(id: string, updates: Partial<Omit<InitiativeRow, "id" | "created_at">>): void {
  const now = new Date().toISOString();
  const fields = Object.keys(updates).filter((k) => k !== "updated_at");
  if (fields.length === 0) return;

  const setClauses = [...fields.map((f) => `${f} = @${f}`), "updated_at = @updated_at"];
  db().prepare(`UPDATE initiatives SET ${setClauses.join(", ")} WHERE id = @id`).run({ ...updates, updated_at: now, id });
}

export function deleteInitiative(id: string): void {
  db().prepare(`DELETE FROM initiatives WHERE id = ?`).run(id);
}
