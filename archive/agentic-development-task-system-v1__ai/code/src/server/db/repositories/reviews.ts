import type Database from "better-sqlite3";
import { getDb } from "../connection.js";

interface ReviewRow {
  id: string;
  work_item_id: string;
  reviewer_agent_id: string | null;
  review_type: string;
  outcome: string;
  summary: string | null;
  details_json: string | null;
  created_at: string;
}

function db(): Database.Database {
  return getDb();
}

export function insertReview(review: ReviewRow): void {
  db().prepare(`
    INSERT INTO reviews (
      id, work_item_id, reviewer_agent_id, review_type,
      outcome, summary, details_json, created_at
    ) VALUES (
      @id, @work_item_id, @reviewer_agent_id, @review_type,
      @outcome, @summary, @details_json, @created_at
    )
  `).run(review);
}

export function getReviewsForWorkItem(workItemId: string): ReviewRow[] {
  return db()
    .prepare(`SELECT * FROM reviews WHERE work_item_id = ? ORDER BY created_at DESC`)
    .all(workItemId) as ReviewRow[];
}

export function getReviewById(id: string): ReviewRow | undefined {
  return db()
    .prepare(`SELECT * FROM reviews WHERE id = ?`)
    .get(id) as ReviewRow | undefined;
}
