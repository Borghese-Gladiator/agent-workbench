import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  default_instructions: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertAgent(agent: AgentRow): void {
  db().prepare(`
    INSERT INTO agents (
      id, name, kind, description, default_instructions,
      is_active, created_at, updated_at
    ) VALUES (
      @id, @name, @kind, @description, @default_instructions,
      @is_active, @created_at, @updated_at
    )
  `).run(agent);
}

export function getAgentById(id: string): AgentRow | undefined {
  return db().prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
}

export function listAgents(): AgentRow[] {
  return db().prepare(`SELECT * FROM agents ORDER BY name`).all() as AgentRow[];
}

export function upsertAgent(agent: AgentRow): void {
  db().prepare(`
    INSERT INTO agents (
      id, name, kind, description, default_instructions,
      is_active, created_at, updated_at
    ) VALUES (
      @id, @name, @kind, @description, @default_instructions,
      @is_active, @created_at, @updated_at
    )
    ON CONFLICT(name) DO UPDATE SET
      kind = excluded.kind,
      description = excluded.description,
      default_instructions = excluded.default_instructions,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at
  `).run(agent);
}
