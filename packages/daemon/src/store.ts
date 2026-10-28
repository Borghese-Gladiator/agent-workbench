import { DatabaseSync } from "node:sqlite";

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
  `);

  const addRepo = db.prepare("INSERT OR IGNORE INTO repos (root, first_seen) VALUES (?, ?)");
  const addSession = db.prepare(
    "INSERT INTO sessions (id, repo, worktree, branch, pid, started_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const endSession = db.prepare(
    "UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ? AND ended_at IS NULL",
  );
  const listSessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC, id DESC");

  return {
    register(s: { id: string; repo: string; worktree: string; branch: string; pid?: number | null }): Session {
      const now = new Date().toISOString();
      addRepo.run(s.repo, now);
      addSession.run(s.id, s.repo, s.worktree, s.branch, s.pid ?? null, now);
      return { ...s, pid: s.pid ?? null, started_at: now, ended_at: null, exit_code: null };
    },
    end(id: string, exitCode: number | null): boolean {
      return endSession.run(new Date().toISOString(), exitCode, id).changes === 1;
    },
    list(): Session[] {
      return listSessions.all() as Session[];
    },
    close() {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
