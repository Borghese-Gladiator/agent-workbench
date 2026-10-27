CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
  author_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edited_at TEXT
);

CREATE INDEX idx_comments_work_item ON comments(work_item_id, created_at);
