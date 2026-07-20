import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

// Types will be created by another agent — see @shared/types
interface ActivityEventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  source_type: string;
  source_ref: string | null;
  actor_type: string;
  actor_id: string | null;
  occurred_at: string;
  payload_json: string;
}

interface ActivityEventFilter {
  entityType?: string;
  entityId?: string;
  limit?: number;
}

function db(): Database.Database {
  return getDb();
}

export function insertActivityEvent(event: ActivityEventRow): void {
  const stmt = db().prepare(`
    INSERT INTO activity_events (
      id, event_type, entity_type, entity_id,
      source_type, source_ref, actor_type, actor_id,
      occurred_at, payload_json
    ) VALUES (
      @id, @event_type, @entity_type, @entity_id,
      @source_type, @source_ref, @actor_type, @actor_id,
      @occurred_at, @payload_json
    )
  `);
  stmt.run(event);
}

export function listActivityEvents(filter?: ActivityEventFilter): ActivityEventRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.entityType) {
    conditions.push("entity_type = ?");
    params.push(filter.entityType);
  }
  if (filter?.entityId) {
    conditions.push("entity_id = ?");
    params.push(filter.entityId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit ? `LIMIT ?` : "";
  if (filter?.limit) {
    params.push(filter.limit);
  }

  return db()
    .prepare(
      `SELECT * FROM activity_events ${where} ORDER BY occurred_at DESC ${limit}`
    )
    .all(...params) as ActivityEventRow[];
}
