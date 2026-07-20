PRAGMA foreign_keys = ON;

-- ============================================================
-- Hierarchy: Initiative > Epic > WorkItem > Sub-task
-- ============================================================

CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'archived')),
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'done', 'archived')),
  color TEXT NOT NULL DEFAULT 'blue'
    CHECK (color IN ('red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan')),
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_epics_initiative ON epics(initiative_id);
CREATE INDEX idx_epics_status ON epics(status);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('planner', 'executor', 'reviewer', 'adversarial_reviewer', 'other')),
  description TEXT,
  default_instructions TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  slug TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('task', 'bug')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'triage'
    CHECK (status IN (
      'triage', 'ready', 'in_progress',
      'in_review', 'done', 'canceled'
    )),
  category TEXT NOT NULL DEFAULT 'work'
    CHECK (category IN ('work', 'personal')),
  awaiting_input INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT REFERENCES terminal_sessions(id) ON DELETE SET NULL,
  assigned_agent_id TEXT REFERENCES agents(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  branch_name TEXT,
  acceptance_criteria TEXT,
  result_summary TEXT,
  sort_order INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT
);

CREATE INDEX idx_work_items_epic ON work_items(epic_id);
CREATE INDEX idx_work_items_parent ON work_items(parent_id);
CREATE INDEX idx_work_items_status ON work_items(status);
CREATE INDEX idx_work_items_kind ON work_items(kind);
CREATE INDEX idx_work_items_sort_order ON work_items(sort_order);
CREATE INDEX idx_work_items_assigned ON work_items(assigned_agent_id);

CREATE TABLE work_item_tags (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (work_item_id, tag)
);

CREATE INDEX idx_work_item_tags_tag ON work_item_tags(tag);

-- ============================================================
-- Supporting tables
-- ============================================================

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT REFERENCES agents(id),
  review_type TEXT NOT NULL CHECK (review_type IN ('adversarial', 'standard', 'human')),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'changes_requested', 'blocked')),
  summary TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_reviews_work_item ON reviews(work_item_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  epic_id TEXT REFERENCES epics(id) ON DELETE CASCADE,
  session_id TEXT,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('file', 'diff', 'note', 'log', 'json', 'other')),
  title TEXT,
  path TEXT,
  mime_type TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_artifacts_work_item ON artifacts(work_item_id);
CREATE INDEX idx_artifacts_epic ON artifacts(epic_id);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('initiative', 'epic', 'work_item', 'agent', 'session', 'review', 'artifact', 'system')),
  entity_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('ingest', 'ui', 'system', 'hook', 'session', 'terminal')),
  source_ref TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_activity_occurred ON activity_events(occurred_at);
CREATE INDEX idx_activity_entity ON activity_events(entity_type, entity_id);
CREATE INDEX idx_activity_event_type ON activity_events(event_type);

CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'exited', 'disconnected', 'archived')),
  tmux_session_name TEXT,
  cwd TEXT,
  branch_name TEXT,
  primary_work_item_id TEXT REFERENCES work_items(id),
  started_at TEXT NOT NULL,
  last_seen_at TEXT,
  exited_at TEXT,
  exit_code INTEGER,
  metadata_json TEXT
);

CREATE INDEX idx_sessions_state ON terminal_sessions(state);
CREATE INDEX idx_sessions_work_item ON terminal_sessions(primary_work_item_id);

CREATE TABLE task_session_links (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary', 'review', 'exploration', 'other')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_session_links_unique ON task_session_links(work_item_id, session_id);

CREATE TABLE ingest_files (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  event_type TEXT,
  ingest_status TEXT NOT NULL CHECK (ingest_status IN ('processed', 'rejected')),
  rejection_reason TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX idx_ingest_sha ON ingest_files(sha256);
