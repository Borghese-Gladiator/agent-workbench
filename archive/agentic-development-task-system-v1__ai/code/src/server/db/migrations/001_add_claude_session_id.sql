-- Add dedicated column for Claude session ID (used for --resume)
ALTER TABLE terminal_sessions ADD COLUMN claude_session_id TEXT;
