import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { run } from "./process.ts";
import { notify } from "./notify.ts";
import type { Log } from "./log.ts";

const AWB = fileURLToPath(new URL("../../cli/bin/awb", import.meta.url));

export type Job = { name: string; at: string; days?: number[]; prompt: string; cwd?: string; allowedTools?: string[]; timeoutMin?: number };
export type Exec = typeof run;
export type JobRun = { id: string; job: string; day: string; state: "running" | "done" | "failed" | "stopped"; started_at: string; ended_at: string | null; end: string | null; output: string | null };

export function parseJobs(text: string): Job[] {
  const jobs = JSON.parse(text);
  if (!Array.isArray(jobs)) throw new Error("schedule.json must be a list of jobs");
  const names = new Set<string>();
  for (const j of jobs) {
    if (!/^[a-z0-9-]+$/.test(j?.name ?? "")) throw new Error(`a job name must be lower case letters, digits and dashes: ${j?.name}`);
    if (names.has(j.name)) throw new Error(`two jobs have the name ${j.name}`);
    names.add(j.name);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(j.at ?? "")) throw new Error(`job ${j.name}: at must be HH:MM, not ${j.at}`);
    if (typeof j.prompt !== "string" || !j.prompt) throw new Error(`job ${j.name}: prompt is empty`);
    if (j.days && !j.days.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) throw new Error(`job ${j.name}: days are 0 (Sunday) to 6`);
  }
  return jobs;
}

const dayOf = (d: Date) => d.toLocaleDateString("sv");
const DEFAULT_DAYS = [1, 2, 3, 4, 5];

export function isDue(job: Job, now: Date, lastDay?: string | null): boolean {
  if (lastDay === dayOf(now)) return false;
  if (!(job.days ?? DEFAULT_DAYS).includes(now.getDay())) return false;
  const [h, m] = job.at.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

export function nextRun(job: Job, now: Date, lastDay?: string | null): string | null {
  const [h, m] = job.at.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const c = new Date(now);
    c.setDate(c.getDate() + i);
    c.setHours(h, m, 0, 0);
    if (!(job.days ?? DEFAULT_DAYS).includes(c.getDay())) continue;
    if (i === 0 && lastDay === dayOf(now)) continue;
    if (i === 0 || c > now) return c.toISOString();
  }
  return null;
}

export function migrateJobs(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job TEXT NOT NULL,
      day TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end TEXT,
      output TEXT
    );
    CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job, started_at);
  `);
}

export class ScheduleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createScheduler(home: string, db: DatabaseSync, log: Log, exec: Exec = run) {
  const file = join(home, "schedule.json");
  const running = new Set<string>();
  const insert = db.prepare("INSERT INTO job_runs (id, job, day, state, started_at) VALUES (?, ?, ?, 'running', ?)");
  const finish = db.prepare("UPDATE job_runs SET state = ?, ended_at = ?, end = ?, output = ? WHERE id = ?");
  const lastDone = db.prepare("SELECT MAX(day) AS day FROM job_runs WHERE job = ? AND state != 'stopped'");
  const recent = db.prepare("SELECT * FROM job_runs ORDER BY started_at DESC, rowid DESC LIMIT ?");
  const lastOf = db.prepare("SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT 1");
  const byId = db.prepare("SELECT * FROM job_runs WHERE id = ?");
  const stopAll = db.prepare("UPDATE job_runs SET state = 'stopped', ended_at = ?, end = 'daemon restart' WHERE state = 'running'");

  function read(): { jobs: Job[]; error: string | null } {
    if (!existsSync(file)) return { jobs: [], error: null };
    try {
      return { jobs: parseJobs(readFileSync(file, "utf8")), error: null };
    } catch (err) {
      return { jobs: [], error: (err as Error).message };
    }
  }

  async function runJob(job: Job, now: Date) {
    const day = dayOf(now);
    const id = randomUUID();
    const out = join(home, "schedule", job.name, `${day}.md`);
    mkdirSync(join(home, "schedule", job.name), { recursive: true });
    insert.run(id, job.name, day, now.toISOString());
    log("info", "schedule", "job.start", { job: job.name, run: id });
    const args = ["-p", "--permission-mode", "acceptEdits", "--allowedTools", ...(job.allowedTools ?? ["Read", "Glob", "Grep", "Bash"])];
    const timeoutMin = job.timeoutMin ?? 30;
    const r = await exec(AWB, args, job.cwd ?? home, job.prompt, timeoutMin * 60_000);
    writeFileSync(out, r.out);
    const ok = r.code === 0 && !r.timedOut;
    const end = r.timedOut ? `timeout after ${timeoutMin} min` : ok ? "done" : `exit ${r.code}`;
    finish.run(ok ? "done" : "failed", new Date().toISOString(), end, out, id);
    log(ok ? "info" : "warn", "schedule", "job.end", { job: job.name, run: id, end, output: out });
    notify(`awb: ${job.name} ${end}`, out, process.env, log);
  }

  function start(job: Job, now: Date) {
    running.add(job.name);
    runJob(job, now)
      .catch((err) => log("warn", "schedule", "job.error", { job: job.name, error: err }))
      .finally(() => running.delete(job.name));
  }

  return {
    recover(now = new Date()) {
      return Number(stopAll.run(now.toISOString()).changes);
    },
    async tick(now = new Date()) {
      const { jobs, error } = read();
      if (error) return log("warn", "schedule", "config.error", { error });
      for (const job of jobs) {
        if (running.has(job.name)) continue;
        if (isDue(job, now, (lastDone.get(job.name) as { day: string | null }).day)) start(job, now);
      }
    },
    runNow(name: string, now = new Date()) {
      const job = read().jobs.find((j) => j.name === name);
      if (!job) throw new ScheduleError(`no job ${name} in ${file}`, 404);
      if (running.has(name)) throw new ScheduleError(`job ${name} is already running`, 409);
      start(job, now);
    },
    status(now = new Date()) {
      const { jobs, error } = read();
      return {
        file,
        error,
        jobs: jobs.map((j) => {
          const day = (lastDone.get(j.name) as { day: string | null }).day;
          return { ...j, days: j.days ?? DEFAULT_DAYS, running: running.has(j.name), last: (lastOf.get(j.name) as JobRun | undefined) ?? null, next: nextRun(j, now, day) };
        }),
      };
    },
    runs(limit = 20) {
      return recent.all(limit) as JobRun[];
    },
    output(id: string): string | null {
      const r = byId.get(id) as JobRun | undefined;
      return r?.output && existsSync(r.output) ? readFileSync(r.output, "utf8") : null;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

export function scheduleRoutes(s: Scheduler) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<Record<string, any>>): Promise<boolean> => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && url.pathname === "/api/schedule") return send(200, s.status()), true;
      if (req.method === "GET" && url.pathname === "/api/schedule/runs") return send(200, s.runs(Number(url.searchParams.get("limit") || 20))), true;
      const out = url.pathname.match(/^\/api\/schedule\/runs\/([\w-]+)\/output$/);
      if (req.method === "GET" && out) {
        const text = s.output(out[1]);
        if (text === null) return send(404, { error: "no output for this run" }), true;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/schedule/run") {
        const { name } = await body();
        s.runNow(String(name));
        return send(202, { started: name }), true;
      }
    } catch (err) {
      if (err instanceof ScheduleError) return send(err.status, { error: err.message }), true;
      throw err;
    }
    return false;
  };
}
