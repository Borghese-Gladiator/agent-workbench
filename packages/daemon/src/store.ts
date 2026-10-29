import { DatabaseSync } from "node:sqlite";
import type { Usage } from "./usage.ts";

export type Session = {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
};

export type Event = {
  id: number;
  session_id: string;
  claude_session_id: string | null;
  repo: string;
  worktree: string;
  branch: string;
  hook: string;
  tool_name: string | null;
  at: string;
  payload: string;
};

export type FeedRow = Session & {
  state: "busy" | "idle" | "ended";
  last_hook: string | null;
  last_tool: string | null;
  last_event_at: string | null;
  usage: Usage | null;
};

const BUSY_HOOKS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);

export function openStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS repos (
      root TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL REFERENCES repos(root),
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      pid INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      claude_session_id TEXT,
      repo TEXT NOT NULL,
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      hook TEXT NOT NULL,
      tool_name TEXT,
      at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
    CREATE TABLE IF NOT EXISTS session_usage (
      session_id TEXT PRIMARY KEY,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_creation INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const addRepo = db.prepare("INSERT OR IGNORE INTO repos (root, first_seen) VALUES (?, ?)");
  const addSession = db.prepare(
    "INSERT INTO sessions (id, repo, worktree, branch, pid, started_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const endSession = db.prepare(
    "UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ? AND ended_at IS NULL",
  );
  const getSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const listSessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC, id DESC");
  const addEvent = db.prepare(
    `INSERT INTO events (session_id, claude_session_id, repo, worktree, branch, hook, tool_name, at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listEvents = db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id");
  const lastEvent = db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 1");
  const lastTool = db.prepare(
    "SELECT tool_name FROM events WHERE session_id = ? AND tool_name IS NOT NULL ORDER BY id DESC LIMIT 1",
  );
  const setUsage = db.prepare(
    `INSERT INTO session_usage (session_id, input, output, cache_read, cache_creation, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET input = excluded.input, output = excluded.output,
       cache_read = excluded.cache_read, cache_creation = excluded.cache_creation, updated_at = excluded.updated_at`,
  );
  const getUsage = db.prepare("SELECT input, output, cache_read, cache_creation FROM session_usage WHERE session_id = ?");

  const feedRow = (s: Session): FeedRow => {
    const last = lastEvent.get(s.id) as Event | undefined;
    const usage = getUsage.get(s.id) as Usage | undefined;
    const ended = !!s.ended_at || last?.hook === "SessionEnd";
    return {
      ...s,
      state: ended ? "ended" : last && BUSY_HOOKS.has(last.hook) ? "busy" : "idle",
      last_hook: last?.hook ?? null,
      last_tool: (lastTool.get(s.id) as { tool_name: string } | undefined)?.tool_name ?? null,
      last_event_at: last?.at ?? null,
      usage: usage ? { ...usage } : null,
    };
  };

  return {
    db,
    register(s: { id: string; repo: string; worktree: string; branch: string; pid?: number | null }): Session {
      const now = new Date().toISOString();
      addRepo.run(s.repo, now);
      addSession.run(s.id, s.repo, s.worktree, s.branch, s.pid ?? null, now);
      return { ...s, pid: s.pid ?? null, started_at: now, ended_at: null, exit_code: null };
    },
    end(id: string, exitCode: number | null): boolean {
      return endSession.run(new Date().toISOString(), exitCode, id).changes === 1;
    },
    session(id: string): Session | undefined {
      return getSession.get(id) as Session | undefined;
    },
    list(): Session[] {
      return listSessions.all() as Session[];
    },
    addEvent(sessionId: string, payload: Record<string, any>): Event {
      const s = this.session(sessionId);
      const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
      const row = {
        session_id: sessionId,
        claude_session_id: payload.session_id ?? null,
        repo: s?.repo ?? cwd,
        worktree: s?.worktree ?? cwd,
        branch: s?.branch ?? "",
        hook: String(payload.hook_event_name ?? "unknown"),
        tool_name: payload.tool_name ?? null,
        at: new Date().toISOString(),
        payload: JSON.stringify(payload),
      };
      const { lastInsertRowid } = addEvent.run(
        row.session_id, row.claude_session_id, row.repo, row.worktree, row.branch, row.hook, row.tool_name, row.at, row.payload,
      );
      return { id: Number(lastInsertRowid), ...row };
    },
    events(sessionId: string): Event[] {
      return listEvents.all(sessionId) as Event[];
    },
    setUsage(sessionId: string, u: Usage) {
      setUsage.run(sessionId, u.input, u.output, u.cache_read, u.cache_creation, new Date().toISOString());
    },
    feed(): FeedRow[] {
      return this.list().map(feedRow);
    },
    feedRow(id: string): FeedRow | undefined {
      const s = this.session(id);
      return s && feedRow(s);
    },
    close() {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
