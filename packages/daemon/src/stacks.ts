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
  fail_reason: string | null;
};

export type TaskRow = Task & { repo: string; created_at: string; failed_claims: string[]; last_gate_at: string | null };

export type TaskFilter = { repo?: string; status?: TaskStatus[]; since?: string };

export function parseSince(v: string, now = Date.now()): string {
  const m = v.match(/^(\d+)([dhm])$/);
  if (m) return new Date(now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"]).toISOString();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new StackError(`bad --since ${v}: use 7d, 12h, 30m or a date`, 400);
  return d.toISOString();
}

export type Stack = { id: string; repo: string; base: string | null; version: number; created_at: string; tasks: Task[] };

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
  const stackCols = (db.prepare("PRAGMA table_info(stacks)").all() as { name: string }[]).map((c) => c.name);
  if (!stackCols.includes("base")) db.exec("ALTER TABLE stacks ADD COLUMN base TEXT;");
  if (!cols.includes("fail_reason")) db.exec("ALTER TABLE tasks ADD COLUMN fail_reason TEXT;");
}

export function taskBranch(title: string, id: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30).replace(/-$/, "");
  return `awb/${slug || "task"}-${id.slice(0, 6)}`;
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
    addStack: db.prepare("INSERT INTO stacks (id, repo, base, version, created_at) VALUES (?, ?, ?, 1, ?)"),
    allStacks: db.prepare("SELECT id FROM stacks ORDER BY created_at DESC, rowid DESC LIMIT ?"),
    newest: db.prepare("SELECT id FROM stacks WHERE repo = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    updBase: db.prepare("UPDATE tasks SET base = ? WHERE id = ?"),
    setFail: db.prepare("UPDATE tasks SET status = 'failed', fail_reason = ? WHERE id = ?"),
    clearFail: db.prepare("UPDATE tasks SET status = 'waiting', fail_reason = NULL WHERE id = ?"),
    byPrefix: db.prepare("SELECT * FROM tasks WHERE id LIKE ? || '%' LIMIT 2"),
    all: db.prepare(
      "SELECT t.*, s.repo FROM tasks t JOIN stacks s ON s.id = t.stack_id WHERE t.created_at >= ? ORDER BY t.created_at DESC, t.position DESC",
    ),
    lastGate: db.prepare(
      "SELECT g.result, g.at FROM gate_results g JOIN attempts a ON a.id = g.attempt_id WHERE a.task_id = ? ORDER BY g.id DESC LIMIT 1",
    ),
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

  const rebase = (stackId: string, fallback?: string) => {
    const stack = get(stackId)!;
    let base = stack.base ?? fallback ?? stack.tasks[0]?.base ?? null;
    stack.tasks.forEach((t, position) => {
      if (t.status === "waiting" && (t.base !== base || t.position !== position)) {
        q.updBase.run(base, t.id);
        q.updTask.run(position, t.title, JSON.stringify(t.claims), t.id);
      }
      base = t.branch;
    });
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
          const id = randomUUID();
          q.addStack.run(id, input.repo, input.base, now);
          if (input.tasks.length === 1) {
            const bound = this.taskForBranch(input.repo, input.branch);
            if (bound && !["done", "merged", "closed"].includes(bound.status)) {
              throw new StackError(`branch ${input.branch} already has task ${bound.id} (${bound.status})`);
            }
          }
          let base = input.base;
          input.tasks.forEach((t, position) => {
            const taskId = randomUUID();
            const branch = input.tasks.length === 1 ? input.branch : taskBranch(t.title, taskId);
            q.addTask.run(taskId, id, position, t.title, JSON.stringify(t.claims), branch, base, taskFolder(taskId), now);
            changes.added.push(taskId);
            base = branch;
          });
          return { stack: get(id)!, changes };
        }

        const current = get(input.stackId);
        if (!current) throw new StackError(`no stack ${input.stackId}`, 404);
        if (input.version !== current.version) {
          throw new StackError(`stale stack version: you sent ${input.version}, the stack is at ${current.version}; read it again`);
        }
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
            q.addTask.run(taskId, current.id, position, t.title, JSON.stringify(t.claims), taskBranch(t.title, taskId), null, taskFolder(taskId), now);
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
        rebase(current.id, input.base);
        const any = changes.added.length + changes.removed.length + changes.changed.length + changes.moved.length;
        if (any) q.bump.run(current.id);
        return { stack: get(current.id)!, changes };
      });
    },

    setStatus(taskId: string, status: TaskStatus) {
      q.setStatus.run(status, taskId);
    },
    stacks(limit = 50): Stack[] {
      return (q.allStacks.all(limit) as { id: string }[]).map((r) => get(r.id)!);
    },
    newestStack(repo: string): Stack | undefined {
      const r = q.newest.get(repo) as { id: string } | undefined;
      return r && get(r.id);
    },
    find(idOrPrefix: string): Task | undefined {
      if (idOrPrefix.length < 6) throw new StackError("a task id prefix needs 6 or more characters", 400);
      const rows = q.byPrefix.all(idOrPrefix) as any[];
      if (rows.length > 1) throw new StackError(`task id prefix ${idOrPrefix} matches more than one task`, 400);
      return rows[0] ? row(rows[0]) : undefined;
    },
    list(f: TaskFilter = {}): TaskRow[] {
      return (q.all.all(f.since ?? "") as any[])
        .map((r) => {
          const t = row(r) as TaskRow;
          const g = q.lastGate.get(t.id) as { result: string; at: string } | undefined;
          const result = g && (JSON.parse(g.result) as GateResult);
          t.failed_claims = result ? result.rows.filter((x) => x.status === "FAIL").map((x) => x.id) : [];
          t.last_gate_at = g?.at ?? null;
          return t;
        })
        .filter((t) => (!f.repo || t.repo === f.repo) && (!f.status?.length || f.status.includes(t.status)));
    },
    remove(ids: string[]): string[] {
      return tx(() => {
        const tasks = ids.map((id) => {
          const t = this.find(id);
          if (!t) throw new StackError(`no task ${id}`, 404);
          if (t.status !== "waiting") throw new StackError(`task ${t.id} is ${t.status}; only waiting tasks can be removed`);
          return t;
        });
        const stacksTouched = new Set(tasks.map((t) => t.stack_id));
        for (const t of tasks) q.delTask.run(t.id);
        for (const id of stacksTouched) {
          q.bump.run(id);
          rebase(id);
        }
        return tasks.map((t) => t.id);
      });
    },
    fail(taskId: string, reason: string) {
      q.setFail.run(reason, taskId);
    },
    retry(taskId: string) {
      q.clearFail.run(taskId);
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
