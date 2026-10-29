import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Claim, GateResult } from "./gate.ts";

export type TaskStatus = "waiting" | "doing" | "done" | "failed" | "merged" | "closed";

export type Task = {
  id: string;
  stack_id: string;
  position: number;
  title: string;
  claims: Claim[];
  status: TaskStatus;
  branch: string | null;
  base: string | null;
  folder: string;
  pr_number: number | null;
  pr_url: string | null;
};

export type Stack = { id: string; repo: string; version: number; created_at: string; tasks: Task[] };

export type TaskInput = { id?: string; title: string; claims: Claim[] };

export type StackChanges = { added: string[]; removed: string[]; changed: string[]; moved: string[] };

export class StackError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export function migrateStacks(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stacks (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      stack_id TEXT NOT NULL REFERENCES stacks(id),
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      claims TEXT NOT NULL,
      status TEXT NOT NULL,
      branch TEXT,
      base TEXT,
      folder TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_stack ON tasks(stack_id, position);
    CREATE INDEX IF NOT EXISTS tasks_branch ON tasks(branch);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS gate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      commit_sha TEXT NOT NULL,
      pass INTEGER NOT NULL,
      result TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("pr_number")) db.exec("ALTER TABLE tasks ADD COLUMN pr_number INTEGER; ALTER TABLE tasks ADD COLUMN pr_url TEXT;");
}

export function validateTasks(tasks: unknown): TaskInput[] {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new StackError("tasks must be a non-empty list", 400);
  return tasks.map((t, i) => {
    if (!t || typeof t.title !== "string" || !t.title.trim()) throw new StackError(`task ${i}: missing title`, 400);
    if (!Array.isArray(t.claims) || t.claims.length === 0) throw new StackError(`task ${i}: missing claims`, 400);
    const ids = new Set<string>();
    for (const c of t.claims) {
      if (!c || typeof c.id !== "string" || !/^C\d+$/.test(c.id)) throw new StackError(`task ${i}: claim id must look like C1`, 400);
      if (typeof c.text !== "string" || !c.text.trim()) throw new StackError(`task ${i}: claim ${c.id} has no text`, 400);
      if (ids.has(c.id)) throw new StackError(`task ${i}: duplicate claim id ${c.id}`, 400);
      ids.add(c.id);
    }
    return { id: typeof t.id === "string" ? t.id : undefined, title: t.title.trim(), claims: t.claims.map((c: Claim) => ({ id: c.id, text: c.text.trim() })) };
  });
}

export function createStacks(db: DatabaseSync, taskFolder: (taskId: string) => string) {
  const row = (r: any): Task => ({ ...r, claims: JSON.parse(r.claims) });
  const q = {
    stack: db.prepare("SELECT * FROM stacks WHERE id = ?"),
    tasks: db.prepare("SELECT * FROM tasks WHERE stack_id = ? ORDER BY position"),
    task: db.prepare("SELECT * FROM tasks WHERE id = ?"),
    byBranch: db.prepare(
      "SELECT t.* FROM tasks t JOIN stacks s ON s.id = t.stack_id WHERE s.repo = ? AND t.branch = ? ORDER BY t.status IN ('merged', 'closed'), t.created_at DESC LIMIT 1",
    ),
    addStack: db.prepare("INSERT INTO stacks (id, repo, version, created_at) VALUES (?, ?, 1, ?)"),
    bump: db.prepare("UPDATE stacks SET version = version + 1 WHERE id = ?"),
    addTask: db.prepare(
      "INSERT INTO tasks (id, stack_id, position, title, claims, status, branch, base, folder, created_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)",
    ),
    updTask: db.prepare("UPDATE tasks SET position = ?, title = ?, claims = ? WHERE id = ?"),
    delTask: db.prepare("DELETE FROM tasks WHERE id = ?"),
    setStatus: db.prepare("UPDATE tasks SET status = ? WHERE id = ?"),
    setPr: db.prepare("UPDATE tasks SET pr_number = ?, pr_url = ?, status = 'done' WHERE id = ?"),
    shipped: db.prepare("SELECT t.*, s.repo FROM tasks t JOIN stacks s ON s.id = t.stack_id WHERE t.status = 'done' AND t.pr_number IS NOT NULL"),
    addAttempt: db.prepare("INSERT INTO attempts (id, task_id, session_id, started_at) VALUES (?, ?, ?, ?)"),
    endAttempt: db.prepare("UPDATE attempts SET ended_at = ? WHERE id = ?"),
    attempts: db.prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY started_at"),
    addGate: db.prepare("INSERT INTO gate_results (attempt_id, commit_sha, pass, result, at) VALUES (?, ?, ?, ?, ?)"),
    gates: db.prepare("SELECT * FROM gate_results WHERE attempt_id = ? ORDER BY id"),
  };

  const get = (id: string): Stack | undefined => {
    const s = q.stack.get(id) as any;
    return s && { ...s, tasks: (q.tasks.all(id) as any[]).map(row) };
  };

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  return {
    get,
    task(id: string): Task | undefined {
      const t = q.task.get(id);
      return t ? row(t) : undefined;
    },
    taskForBranch(repo: string, branch: string): Task | undefined {
      const t = q.byBranch.get(repo, branch);
      return t ? row(t) : undefined;
    },

    set(input: { stackId?: string; version?: number; repo: string; branch: string; base: string; tasks: TaskInput[] }) {
      return tx(() => {
        const now = new Date().toISOString();
        const changes: StackChanges = { added: [], removed: [], changed: [], moved: [] };

        if (!input.stackId) {
          if (input.tasks.length !== 1) throw new StackError("phase 3 supports a stack of one task only", 400);
          const bound = this.taskForBranch(input.repo, input.branch);
          if (bound && !["done", "merged", "closed"].includes(bound.status)) {
            throw new StackError(`branch ${input.branch} already has task ${bound.id} (${bound.status})`);
          }
          const id = randomUUID();
          q.addStack.run(id, input.repo, now);
          const [t] = input.tasks;
          const taskId = randomUUID();
          q.addTask.run(taskId, id, 0, t.title, JSON.stringify(t.claims), input.branch, input.base, taskFolder(taskId), now);
          changes.added.push(taskId);
          return { stack: get(id)!, changes };
        }

        const current = get(input.stackId);
        if (!current) throw new StackError(`no stack ${input.stackId}`, 404);
        if (input.version !== current.version) {
          throw new StackError(`stale stack version: you sent ${input.version}, the stack is at ${current.version}; read it again`);
        }
        if (input.tasks.length !== 1) throw new StackError("phase 3 supports a stack of one task only", 400);

        const keep = new Set(input.tasks.map((t) => t.id).filter(Boolean));
        for (const t of current.tasks) {
          if (keep.has(t.id)) continue;
          if (t.status !== "waiting") throw new StackError(`task ${t.id} is ${t.status}; only waiting tasks can be removed`);
          q.delTask.run(t.id);
          changes.removed.push(t.id);
        }
        input.tasks.forEach((t, position) => {
          const old = t.id ? current.tasks.find((x) => x.id === t.id) : undefined;
          if (t.id && !old) throw new StackError(`task ${t.id} is not in stack ${current.id}`, 404);
          if (!old) {
            const taskId = randomUUID();
            q.addTask.run(taskId, current.id, position, t.title, JSON.stringify(t.claims), input.branch, input.base, taskFolder(taskId), now);
            changes.added.push(taskId);
            return;
          }
          const edited = old.title !== t.title || JSON.stringify(old.claims) !== JSON.stringify(t.claims);
          const moved = old.position !== position;
          if ((edited || moved) && old.status !== "waiting") {
            throw new StackError(`task ${old.id} is ${old.status}; only waiting tasks can change`);
          }
          if (edited) changes.changed.push(old.id);
          if (moved) changes.moved.push(old.id);
          if (edited || moved) q.updTask.run(position, t.title, JSON.stringify(t.claims), old.id);
        });
        const any = changes.added.length + changes.removed.length + changes.changed.length + changes.moved.length;
        if (any) q.bump.run(current.id);
        return { stack: get(current.id)!, changes };
      });
    },

    setStatus(taskId: string, status: TaskStatus) {
      q.setStatus.run(status, taskId);
    },
    setPr(taskId: string, number: number, url: string) {
      q.setPr.run(number, url, taskId);
    },
    shipped(): (Task & { repo: string })[] {
      return (q.shipped.all() as any[]).map(row) as (Task & { repo: string })[];
    },
    startAttempt(taskId: string, sessionId: string | null): string {
      const id = randomUUID();
      q.addAttempt.run(id, taskId, sessionId, new Date().toISOString());
      return id;
    },
    endAttempt(attemptId: string) {
      q.endAttempt.run(new Date().toISOString(), attemptId);
    },
    saveGate(attemptId: string, g: GateResult) {
      q.addGate.run(attemptId, g.head, g.pass ? 1 : 0, JSON.stringify(g), new Date().toISOString());
    },
    history(taskId: string) {
      return (q.attempts.all(taskId) as any[]).map((a) => ({
        ...a,
        gates: (q.gates.all(a.id) as any[]).map((g) => ({ ...g, pass: !!g.pass, result: JSON.parse(g.result) })),
      }));
    },
  };
}

export type Stacks = ReturnType<typeof createStacks>;
