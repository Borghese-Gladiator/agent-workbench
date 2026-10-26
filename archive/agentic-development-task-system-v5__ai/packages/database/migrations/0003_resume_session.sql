-- TASK-32: durable agent-session resume. Persist the provider's resumable session token on each
-- agent session so a Temporal retry — even after a worker restart — resumes the transcript instead of
-- cold-starting. Additive nullable column; existing rows keep NULL (no resume handle known).
ALTER TABLE agent_sessions ADD COLUMN resume_session_id TEXT;
