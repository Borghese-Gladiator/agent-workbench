-- 0001_init.sql
-- Base schema for the Agentic Workbench SQLite database.

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  name TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT NOT NULL,
  trusted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repository_snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  head_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  repository_map_artifact_id TEXT
);

CREATE TABLE repository_units (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  snapshot_id TEXT REFERENCES repository_snapshots(id),
  root TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  framework TEXT,
  package_manager TEXT,
  depends_on_json TEXT NOT NULL
);

CREATE TABLE repository_commands (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  unit_id TEXT REFERENCES repository_units(id),
  purpose TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  validated_at_sha TEXT,
  last_exit_code INTEGER
);

CREATE TABLE repository_services (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  unit_id TEXT REFERENCES repository_units(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_command_id TEXT REFERENCES repository_commands(id),
  healthcheck_command_id TEXT REFERENCES repository_commands(id),
  default_port INTEGER
);

CREATE TABLE repository_qa_surfaces (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  unit_id TEXT REFERENCES repository_units(id),
  kind TEXT NOT NULL,
  entrypoint TEXT NOT NULL,
  description TEXT
);

CREATE TABLE repository_facts (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence TEXT NOT NULL,
  observed_at_sha TEXT NOT NULL,
  source_paths_json TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL,
  invalidated_by_paths_json TEXT NOT NULL,
  superseded_by TEXT
);

CREATE TABLE repository_fact_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL REFERENCES repository_facts(id),
  path TEXT NOT NULL,
  sha256 TEXT
);

CREATE TABLE repository_symbols (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  snapshot_id TEXT REFERENCES repository_snapshots(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER
);

CREATE TABLE repository_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  from_unit_id TEXT NOT NULL REFERENCES repository_units(id),
  to_unit_id TEXT NOT NULL REFERENCES repository_units(id),
  kind TEXT NOT NULL,
  weight REAL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  prompt TEXT NOT NULL,
  phase TEXT NOT NULL,
  condition TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_contracts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  objective TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  non_goals_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE acceptance_claims (
  id TEXT PRIMARY KEY,
  task_contract_id TEXT NOT NULL REFERENCES task_contracts(id),
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  deterministic_evidence_required INTEGER NOT NULL,
  qa_evidence_required INTEGER NOT NULL,
  human_judgment_required INTEGER NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  contract_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  summary TEXT NOT NULL,
  affected_areas_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE plan_slices (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  objective TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  likely_paths_json TEXT NOT NULL,
  required_targeted_checks_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL
);

CREATE TABLE plan_claim_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  claim_id TEXT NOT NULL,
  plan_slice_ids_json TEXT NOT NULL,
  qa_scenario_ids_json TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL
);

CREATE TABLE phase_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT
);

CREATE TABLE workspace_leases (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  execution_profile TEXT NOT NULL,
  allocated_ports_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase_attempt_id TEXT NOT NULL REFERENCES phase_attempts(id),
  phase TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER,
  cost_usd REAL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  tool TEXT NOT NULL,
  input_summary TEXT,
  result_summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE command_executions (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT REFERENCES agent_sessions(id),
  phase_attempt_id TEXT NOT NULL REFERENCES phase_attempts(id),
  command_id TEXT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE semantic_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  phase_attempt_id TEXT NOT NULL REFERENCES phase_attempts(id),
  producer TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  artifact_id TEXT
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  candidate_sha TEXT,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  description TEXT NOT NULL,
  reproduction_json TEXT,
  proposed_remediation TEXT,
  status TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase_attempt_id TEXT NOT NULL REFERENCES phase_attempts(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  plan_version INTEGER,
  repository_snapshot_id TEXT NOT NULL,
  base_sha TEXT,
  candidate_sha TEXT,
  environment_digest TEXT,
  scenario_version INTEGER,
  policy_version TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  claim_id TEXT NOT NULL
);

CREATE TABLE evidence_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  depends_on_evidence_id TEXT NOT NULL REFERENCES evidence(id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  phase_attempt_id TEXT REFERENCES phase_attempts(id),
  candidate_sha TEXT,
  kind TEXT NOT NULL,
  retention TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE human_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  decision TEXT NOT NULL,
  notes TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE waivers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  finding_id TEXT REFERENCES findings(id),
  reason TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  number INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pull_request_feedback (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id),
  author TEXT,
  path TEXT,
  line INTEGER,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  repository_id TEXT REFERENCES repositories(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  path TEXT,
  task_id TEXT,
  description TEXT
);

CREATE TABLE failure_signatures (
  id TEXT PRIMARY KEY,
  repository_id TEXT REFERENCES repositories(id),
  signature TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- FTS5 virtual tables + sync triggers.

CREATE VIRTUAL TABLE repository_facts_fts USING fts5(
  statement,
  content='repository_facts',
  content_rowid='rowid'
);

CREATE TRIGGER repository_facts_ai AFTER INSERT ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
END;
CREATE TRIGGER repository_facts_ad AFTER DELETE ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(repository_facts_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
END;
CREATE TRIGGER repository_facts_au AFTER UPDATE ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(repository_facts_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
  INSERT INTO repository_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
END;

CREATE VIRTUAL TABLE repository_symbols_fts USING fts5(
  name,
  signature,
  content='repository_symbols',
  content_rowid='rowid'
);

CREATE TRIGGER repository_symbols_ai AFTER INSERT ON repository_symbols BEGIN
  INSERT INTO repository_symbols_fts(rowid, name, signature) VALUES (new.rowid, new.name, new.signature);
END;
CREATE TRIGGER repository_symbols_ad AFTER DELETE ON repository_symbols BEGIN
  INSERT INTO repository_symbols_fts(repository_symbols_fts, rowid, name, signature) VALUES ('delete', old.rowid, old.name, old.signature);
END;
CREATE TRIGGER repository_symbols_au AFTER UPDATE ON repository_symbols BEGIN
  INSERT INTO repository_symbols_fts(repository_symbols_fts, rowid, name, signature) VALUES ('delete', old.rowid, old.name, old.signature);
  INSERT INTO repository_symbols_fts(rowid, name, signature) VALUES (new.rowid, new.name, new.signature);
END;

CREATE VIRTUAL TABLE task_contracts_fts USING fts5(
  objective,
  content='task_contracts',
  content_rowid='rowid'
);

CREATE TRIGGER task_contracts_ai AFTER INSERT ON task_contracts BEGIN
  INSERT INTO task_contracts_fts(rowid, objective) VALUES (new.rowid, new.objective);
END;
CREATE TRIGGER task_contracts_ad AFTER DELETE ON task_contracts BEGIN
  INSERT INTO task_contracts_fts(task_contracts_fts, rowid, objective) VALUES ('delete', old.rowid, old.objective);
END;
CREATE TRIGGER task_contracts_au AFTER UPDATE ON task_contracts BEGIN
  INSERT INTO task_contracts_fts(task_contracts_fts, rowid, objective) VALUES ('delete', old.rowid, old.objective);
  INSERT INTO task_contracts_fts(rowid, objective) VALUES (new.rowid, new.objective);
END;

CREATE VIRTUAL TABLE findings_fts USING fts5(
  description,
  content='findings',
  content_rowid='rowid'
);

CREATE TRIGGER findings_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts(rowid, description) VALUES (new.rowid, new.description);
END;
CREATE TRIGGER findings_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, description) VALUES ('delete', old.rowid, old.description);
END;
CREATE TRIGGER findings_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, description) VALUES ('delete', old.rowid, old.description);
  INSERT INTO findings_fts(rowid, description) VALUES (new.rowid, new.description);
END;

CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
  title,
  body,
  content='memory_entries',
  content_rowid='rowid'
);

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
