-- §27 observability detail (TASK-22): runtime-attribution buckets and context-composition buckets.
-- These are additive; the run-state tables from 0001 are untouched.

-- The 12 runtime-attribution buckets, accrued per phase attempt (spec §27). Coarse `runtimeMsByPhase`
-- already lives in the workflow; this is the fine breakdown of where a phase's wall-clock went.
CREATE TABLE runtime_attribution (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase_attempt_id TEXT NOT NULL REFERENCES phase_attempts(id),
  phase TEXT NOT NULL,
  environment_setup_ms INTEGER NOT NULL DEFAULT 0,
  dependency_install_ms INTEGER NOT NULL DEFAULT 0,
  model_wait_ms INTEGER NOT NULL DEFAULT 0,
  model_generation_ms INTEGER NOT NULL DEFAULT 0,
  tool_execution_ms INTEGER NOT NULL DEFAULT 0,
  test_execution_ms INTEGER NOT NULL DEFAULT 0,
  service_startup_ms INTEGER NOT NULL DEFAULT 0,
  qa_execution_ms INTEGER NOT NULL DEFAULT 0,
  artifact_processing_ms INTEGER NOT NULL DEFAULT 0,
  github_operation_ms INTEGER NOT NULL DEFAULT 0,
  human_wait_ms INTEGER NOT NULL DEFAULT 0,
  retry_backoff_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_attribution_task ON runtime_attribution(task_id);
CREATE UNIQUE INDEX idx_runtime_attribution_attempt ON runtime_attribution(phase_attempt_id);

-- The 8 context-composition buckets (spec §27): how many tokens of each source went into an agent
-- session's assembled context. Keyed per agent session.
CREATE TABLE context_composition (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  phase TEXT NOT NULL,
  role TEXT NOT NULL,
  contract_tokens INTEGER NOT NULL DEFAULT 0,
  plan_tokens INTEGER NOT NULL DEFAULT 0,
  diff_tokens INTEGER NOT NULL DEFAULT 0,
  evidence_tokens INTEGER NOT NULL DEFAULT 0,
  findings_tokens INTEGER NOT NULL DEFAULT 0,
  repository_map_tokens INTEGER NOT NULL DEFAULT 0,
  memory_tokens INTEGER NOT NULL DEFAULT 0,
  instruction_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_context_composition_task ON context_composition(task_id);
CREATE UNIQUE INDEX idx_context_composition_session ON context_composition(agent_session_id);
