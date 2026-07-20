// === Hierarchy statuses ===
export const INITIATIVE_STATUSES = ["active", "completed", "archived"] as const;
export const EPIC_STATUSES = ["open", "in_progress", "done", "archived"] as const;
export const EPIC_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export const WORK_ITEM_KINDS = ["task", "bug"] as const;
export const WORK_ITEM_STATUSES = [
  "triage", "ready", "in_progress",
  "in_review", "done", "canceled",
] as const;
export const WORK_ITEM_CATEGORIES = ["work", "personal"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;

// === Other enums ===
export const AGENT_KINDS = ["planner", "executor", "reviewer", "adversarial_reviewer", "other"] as const;
export const REVIEW_TYPES = ["adversarial", "standard", "human"] as const;
export const REVIEW_OUTCOMES = ["approved", "changes_requested", "blocked"] as const;
export const ARTIFACT_TYPES = ["file", "diff", "note", "log", "json", "other"] as const;
export const SESSION_STATES = ["starting", "running", "exited", "disconnected", "archived"] as const;
export const SESSION_ROLES = ["primary", "secondary", "review", "exploration", "other"] as const;

export const ENTITY_TYPES = [
  "initiative", "epic", "work_item", "agent",
  "session", "review", "artifact", "system",
] as const;
export const SOURCE_TYPES = ["ingest", "ui", "system", "hook", "session", "terminal"] as const;
export const ACTOR_TYPES = ["user", "agent", "system"] as const;

// === Status transitions ===
export const ALLOWED_WORK_ITEM_TRANSITIONS: Record<string, string[]> = {
  triage:      ["ready", "canceled"],
  ready:       ["in_progress", "triage", "canceled"],
  in_progress: ["in_review", "done", "triage", "canceled"],
  in_review:   ["in_progress", "done", "triage"],
  done:        [],
  canceled:    ["triage"],
};

export const ALLOWED_EPIC_TRANSITIONS: Record<string, string[]> = {
  open:        ["in_progress", "archived"],
  in_progress: ["done", "archived"],
  done:        ["archived"],
  archived:    [],
};

// === Ingest event types ===
export const INGEST_EVENT_TYPES = [
  "work_item.created",
  "work_item.updated",
  "work_item.status_changed",
  "work_item.assigned",
  "work_item.session_linked",
  "epic.created",
  "review.requested",
  "review.completed",
  "artifact.attached",
  "session.declared",
] as const;

// === System actors ===
export const ADVERSARIAL_REVIEW_BOT_ID = "adversarial-review-bot";

// === Directory structure ===
export const INGEST_DIR = "data/ingest";
export const INBOX_DIR = "inbox";
export const PROCESSED_DIR = "processed";
export const REJECTED_DIR = "rejected";
export const ATTACHMENTS_DIR = "attachments";
