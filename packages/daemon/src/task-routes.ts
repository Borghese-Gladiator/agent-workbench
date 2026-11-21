import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { FINISHED, parseSince, StackError, validateTasks, type Stacks, type Task, type TaskStatus } from "./stacks.ts";
import { LEVELS, logText, readLog, type Level, type Log, type LogFilter } from "./log.ts";
import { prove, run, type CarriedTask, type ProveDeps } from "./prove.ts";
import { readRunFile, seedDir } from "./run-md.ts";
import { costReport, costText } from "./cost.ts";
import type { DatabaseSync } from "node:sqlite";
import { ship, ShipRefused, syncStatus } from "./ship.ts";
import { resumeStopped, retryCount, type createRunner } from "./runner.ts";
import { currentLimit, setStackLimit } from "./config.ts";

import { TYPES, branchDiff, carriedClaims, costOf, proofFile, stopSessions, toolCallsOf, type Json } from "./task-helpers.ts";

export { branchDiff, carriedClaims, costOf, isAwbSession, proofFile, stopSessions, toolCallsOf } from "./task-helpers.ts";

export function taskRoutes(
  stacks: Stacks,
  proveDeps: Omit<ProveDeps, "log">,
  runner: ReturnType<typeof createRunner>,
  usageOf: (sessionId: string) => unknown = () => null,
  home = "",
  db?: DatabaseSync,
  log: Log = () => {},
  logDir = "",
) {
  const proofs = new Map<string, AbortController>();
  const running = new Map<string, { kind: "prove" | "ship"; lines: Json[]; listeners: Set<ServerResponse> }>();
  const begin = (id: string, kind: "prove" | "ship", res: ServerResponse) => {
    const r = { kind, lines: [] as Json[], listeners: new Set([res]) };
    running.set(id, r);
    res.on("close", () => r.listeners.delete(res));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return {
      line: (o: Json) => {
        r.lines.push(o);
        for (const l of r.listeners) l.write(JSON.stringify(o) + "\n");
      },
      end: () => {
        running.delete(id);
        for (const l of r.listeners) l.end();
      },
    };
  };

  async function syncPrs() {
    for (const t of stacks.shipped()) {
      const r = await run("gh", ["pr", "view", String(t.pr_number), "--json", "state"], t.repo);
      if (r.code !== 0) {
        log("warn", "sync", "pr.error", { task: t.id, pr: t.pr_number, repo: t.repo, error: r.out.trim().slice(0, 500) });
        continue;
      }
      const next = syncStatus(JSON.parse(r.out).state);
      if (next) {
        stacks.setStatus(t.id, next);
        log("info", "sync", "pr.state", { task: t.id, pr: t.pr_number, state: next });
      }
    }
  }

  function detail(t: Task) {
    const files = existsSync(t.folder) ? readdirSync(t.folder) : [];
    const transcripts = [
      ...files.filter((f) => /^session-\d+\.jsonl$/.test(f)).sort().map((f) => join(t.folder, f)),
      ...(existsSync(join(t.folder, "proof", "writer.jsonl")) ? [join(t.folder, "proof", "writer.jsonl")] : []),
    ];
    const attempts = stacks.history(t.id).map((a: any) => ({ ...a, usage: a.session_id ? usageOf(a.session_id) : null }));
    const tests = join(t.folder, "proof-tests");
    const specs = existsSync(tests)
      ? readdirSync(tests).filter((f) => /\.spec\.(ts|js)$/.test(f) && f !== "seed.spec.ts").sort().map((name) => ({ name, text: readFileSync(join(tests, name), "utf8") }))
      : [];
    const sessionFiles = transcripts.filter((f) => !f.endsWith("writer.jsonl"));
    const sessionUsd = sessionFiles.reduce((n, f) => n + costOf(f), 0);
    const tool_calls = sessionFiles.reduce((n, f) => n + toolCallsOf(f), 0);
    const saved = attempts.map((a: any) => a.writer_usd).filter((v: unknown): v is number => typeof v === "number");
    const writerUsd = saved.length ? saved.reduce((n: number, v: number) => n + v, 0) : transcripts.filter((f) => f.endsWith("writer.jsonl")).reduce((n, f) => n + costOf(f), 0);
    const lines = logDir ? readLog(logDir, { task: t.id, limit: 200 }) : [];
    const writerEndFile = join(t.folder, "proof", "writer-end.txt");
    const lastWriter = lines.findLast((l) => l.source === "prove" && l.event === "gate" && typeof l.writer === "string");
    const writer_end = existsSync(writerEndFile) ? readFileSync(writerEndFile, "utf8").trim() : ((lastWriter?.writer as string | undefined) ?? null);
    const own = home ? join(realpathSync(home), "worktrees", t.id) : "";
    const last = db?.prepare("SELECT s.worktree FROM attempts a JOIN sessions s ON s.id = a.session_id WHERE a.task_id = ? ORDER BY a.started_at DESC LIMIT 1").get(t.id) as
      | { worktree: string }
      | undefined;
    const worktree = own && existsSync(own) ? own : (last?.worktree ?? null);
    return { ...t, stack: stacks.get(t.stack_id), attempts, transcripts, specs, log: lines, writer_end, worktree, tool_calls, cost_usd: sessionUsd + writerUsd, writer_usd: writerUsd };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<Json>): Promise<boolean> {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const fail = (err: unknown) => {
      if (err instanceof StackError) send(err.status, { error: err.message });
      else throw err;
    };

    if (req.method === "POST" && url.pathname === "/api/stacks") {
      const b = await body();
      try {
        for (const k of ["repo", "branch", "base"]) if (typeof b[k] !== "string" || !b[k]) throw new StackError(`missing ${k}`, 400);
        const result = stacks.set({ stackId: b.stackId, version: b.version, repo: b.repo, branch: b.branch, base: b.base, tasks: validateTasks(b.tasks) });
        send(b.stackId ? 200 : 201, result);
      } catch (err) {
        fail(err);
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/task") {
      const t = stacks.taskForBranch(url.searchParams.get("repo") ?? "", url.searchParams.get("branch") ?? "");
      if (!t) send(404, { error: "no task on this branch; run awb stack set first" });
      else send(200, detail(t));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/prove") {
      const b = await body();
      const t = stacks.taskForBranch(b.repo ?? "", b.branch ?? "");
      if (!t) return send(404, { error: "no task on this branch; run awb stack set first" }), true;
      const current = running.get(t.id);
      if (current?.kind === "ship") return send(409, { error: `a ship for task ${t.id} is already running` }), true;
      if (current) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const ignored = Array.isArray(b.rewrite) && b.rewrite.length ? `; the --rewrite value ${b.rewrite.join(",")} is ignored` : "";
        res.write(JSON.stringify({ log: `a proof run for task ${t.id} is already running; waiting for its result${ignored}` }) + "\n");
        for (const o of current.lines) res.write(JSON.stringify(o) + "\n");
        current.listeners.add(res);
        res.on("close", () => current.listeners.delete(res));
        return true;
      }
      if (!["waiting", "doing", "failed"].includes(t.status)) return send(409, { error: `task ${t.id} is ${t.status}` }), true;
      const rewrite: string[] = Array.isArray(b.rewrite) ? b.rewrite.map(String) : [];
      const unknown = rewrite.filter((id) => !t.claims.some((c) => c.id === id));
      if (unknown.length) return send(400, { error: `no claim ${unknown.join(", ")} in task ${t.id}` }), true;

      const ctrl = new AbortController();
      proofs.set(t.id, ctrl);
      const { line, end } = begin(t.id, "prove", res);
      const before = t.status;
      const ownedByRun = runner.owns(t.id);
      stacks.setStatus(t.id, "doing");
      const attempt = stacks.startAttempt(t.id, typeof b.sessionId === "string" ? b.sessionId : null);
      const ids = { task: t.id, attempt, session: typeof b.sessionId === "string" ? b.sessionId : undefined };
      log("info", "prove", "start", { ...ids, rewrite: rewrite.length ? rewrite : undefined });
      let after: TaskStatus = before === "failed" ? "failed" : "waiting";
      try {
        const r = await prove(t, b.worktree, readRunFile(home, b.repo, b.worktree), { ...proveDeps, deadline: Number(b.deadline) || undefined, seedDir: seedDir(home, b.repo), signal: ctrl.signal, log: (msg) => (line({ log: msg }), log("info", "prove", "step", { ...ids, msg })) }, rewrite, carriedClaims(stacks, t));
        stacks.saveGate(attempt, r.gate);
        if (r.writer?.usd != null) stacks.setWriterCost(attempt, r.writer.usd);
        const failed = r.gate.rows.filter((x) => x.status === "FAIL").map((x) => `${x.id}: ${x.reasons.join(", ")}`);
        log(r.gate.pass ? "info" : "warn", "prove", "gate", { ...ids, pass: r.gate.pass, sha: r.gate.head, failed: failed.length ? failed : undefined, writer: r.writer?.end, writer_usd: r.writer?.usd });
        after = r.gate.pass ? "waiting" : after;
        line({ result: { pass: r.gate.pass, table: r.table, rows: r.gate.rows, folder: r.folder, taskId: t.id, writer: r.writer } });
      } catch (err) {
        log("error", "prove", "error", { ...ids, error: err });
        line({ error: (err as Error).message });
      } finally {
        stacks.endAttempt(attempt);
        if (!ownedByRun) stacks.setStatus(t.id, after);
        proofs.delete(t.id);
        end();
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ship") {
      const b = await body();
      const t = stacks.taskForBranch(b.repo ?? "", b.branch ?? "");
      if (!t) return send(404, { error: "no task on this branch; run awb stack set first" }), true;
      if (!["waiting", "doing", "failed"].includes(t.status)) return send(409, { error: `task ${t.id} is ${t.status}: ${t.pr_url}` }), true;
      if (running.has(t.id)) return send(409, { error: `a proof run or ship for task ${t.id} is already running` }), true;

      const { line, end } = begin(t.id, "ship", res);
      try {
        log("info", "ship", "start", { task: t.id, branch: t.branch });
        const r = await ship(t, b.worktree, readRunFile(home, b.repo, b.worktree), (msg) => (line({ log: msg }), log("info", "ship", "step", { task: t.id, msg })), stacks.get(t.stack_id)?.tasks);
        stacks.setPr(t.id, r.number, r.url);
        log("info", "ship", "pr", { task: t.id, pr: r.number, url: r.url });
        line({ result: { url: r.url, number: r.number, table: r.table, taskId: t.id } });
      } catch (err) {
        log(err instanceof ShipRefused ? "warn" : "error", "ship", err instanceof ShipRefused ? "refused" : "error", { task: t.id, error: err });
        line({ error: (err as Error).message, table: err instanceof ShipRefused ? err.table : undefined });
      } finally {
        end();
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const b = await body();
      try {
        const retries = retryCount(b.retries);
        const { stack, task } = b.id ? stacks.resolve(String(b.id)) : { stack: stacks.newestStack(b.repo ?? ""), task: undefined };
        if (!stack) throw new StackError("no stack for this repo; run awb stack set first", 404);
        if (task) {
          const below = stack.tasks.slice(0, stack.tasks.findIndex((t) => t.id === task.id));
          const blocker = below.find((t) => !FINISHED.includes(t.status));
          if (task.status !== "waiting") throw new StackError(`task ${task.id} is ${task.status}; only a waiting task can be started`);
          if (blocker) throw new StackError(`task ${blocker.id} is ${blocker.status}; it must be done before task ${task.id} can start`);
        }
        return send(202, runner.start(stack.id, retries, task && [task.id])), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const p = url.searchParams;
      const level = p.get("level") ?? undefined;
      if (level && !LEVELS.includes(level as Level)) return send(400, { error: `bad level ${level}: use ${LEVELS.join(", ")}` }), true;
      let since: string | undefined;
      try {
        since = p.get("since") ? parseSince(p.get("since")!) : undefined;
      } catch (err) {
        return fail(err), true;
      }
      const f: LogFilter = {
        task: p.get("task") ?? undefined,
        run: p.get("run") ?? undefined,
        session: p.get("session") ?? undefined,
        source: p.get("source") ?? undefined,
        level: level as Level | undefined,
        since,
        limit: Number(p.get("limit") || 500),
      };
      const lines = logDir ? readLog(logDir, f) : [];
      if (p.get("format") === "text") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(lines.map(logText).join("\n") + (lines.length ? "\n" : "")), true;
      }
      return send(200, lines), true;
    }

    if (req.method === "POST" && url.pathname === "/api/log") {
      const b = await body();
      const level = LEVELS.includes(b.level) ? (b.level as Level) : "error";
      if (typeof b.event !== "string" || !b.event) return send(400, { error: "missing event" }), true;
      const { level: _l, source: _s, event, ts: _t, ...fields } = b;
      log(level, "cli", String(event).slice(0, 100), fields);
      return send(201, { ok: true }), true;
    }

    if (req.method === "GET" && url.pathname === "/api/cost") {
      if (!db) return send(501, { error: "no database" }), true;
      try {
        const since = parseSince(url.searchParams.get("since") ?? "7d");
        const report = costReport(db, since, url.searchParams.get("repo") ?? undefined);
        if (url.searchParams.get("format") === "text") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(costText(report)), true;
        }
        return send(200, report), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/resume") {
      if (!db) return send(501, { error: "no database" }), true;
      const id = url.searchParams.get("id");
      const repo = url.searchParams.get("repo");
      const branch = url.searchParams.get("branch");
      const pick = (from: string, where: string, order: string, ...args: string[]) =>
        db.prepare(
          `SELECT * FROM (SELECT s.id AS session_id, s.repo, s.worktree, s.branch, ${order} AS at,
             (SELECT e.claude_session_id FROM events e WHERE e.session_id = s.id AND e.claude_session_id IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS claude_session_id
           FROM ${from} WHERE ${where}) WHERE claude_session_id IS NOT NULL ORDER BY at DESC, session_id DESC LIMIT 1`,
        ).get(...args) as Json | undefined;
      const answer = (r: Json | undefined, error: string, extra: Json = {}) =>
        (send(r ? 200 : 404, r ? { ...r, ...extra } : { error }), true);
      if (!id) {
        if (!repo || !branch) return send(400, { error: "missing id, or repo and branch" }), true;
        return answer(
          pick("sessions s", "s.repo = ? AND s.branch = ?", "s.started_at", repo, branch),
          `no session with a claude session id on branch ${branch} of ${repo}`,
        );
      }
      if (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) {
        return answer(pick("sessions s", "s.id = ?", "s.started_at", id), `session ${id} has no claude session id`);
      }
      const byClaude = db.prepare("SELECT session_id FROM events WHERE claude_session_id = ? ORDER BY id DESC LIMIT 1").get(id) as Json | undefined;
      if (byClaude) {
        return answer(pick("sessions s", "s.id = ?", "s.started_at", String(byClaude.session_id)), `no session for claude session ${id}`, { claude_session_id: id });
      }
      let t: Task | undefined;
      try {
        t = id.length >= 6 ? stacks.find(id) : undefined;
      } catch (err) {
        return fail(err), true;
      }
      if (!t) return send(404, { error: `no session or task ${id}` }), true;
      return answer(
        pick("attempts a JOIN sessions s ON s.id = a.session_id", "a.task_id = ?", "a.started_at", t.id),
        `task ${id} has no attempt with a claude session id`,
        { task_id: t.id },
      );
    }

    if (req.method === "GET" && url.pathname === "/api/session-tasks") {
      return send(200, stacks.sessionTasks()), true;
    }

    if (req.method === "GET" && url.pathname === "/api/stacks") {
      return send(200, stacks.stacks()), true;
    }

    if (req.method === "GET" && url.pathname === "/files") {
      const f = proofFile(home, url.searchParams.get("path") ?? "");
      if (!f) return send(404, { error: "no such proof file" }), true;
      res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream", "content-length": statSync(f).size });
      createReadStream(f).pipe(res);
      return true;
    }

    const diffMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/diff$/);
    if (req.method === "GET" && diffMatch) {
      const t = stacks.find(diffMatch[1]);
      if (!t) return send(404, { error: `no task ${diffMatch[1]}` }), true;
      const repo = stacks.get(t.stack_id)!.repo;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(t.branch && t.base ? branchDiff(repo, t.base, t.branch) : "");
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/tasks") {
      try {
        const p = url.searchParams;
        const status = p.get("status")?.split(",").filter(Boolean) as TaskStatus[] | undefined;
        const since = p.get("since");
        return send(200, stacks.list({ repo: p.get("repo") || undefined, status, since: since ? parseSince(since) : undefined })), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/tasks/rm") {
      const b = await body();
      try {
        if (!Array.isArray(b.ids) || !b.ids.length) throw new StackError("ids must be a non-empty list", 400);
        return send(200, { removed: stacks.remove(b.ids.map(String)) }), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (req.method === "GET" && taskMatch) {
      try {
        const t = stacks.find(taskMatch[1]);
        if (!t) return send(404, { error: `no task ${taskMatch[1]}` }), true;
        return send(200, detail(t)), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/runs") {
      return send(200, stacks.runs(Number(url.searchParams.get("limit") || 10))), true;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
    if (req.method === "GET" && runMatch) {
      const r = runner.get(runMatch[1]);
      return send(r ? 200 : 404, r ?? { error: "no such run" }), true;
    }

    if (req.method === "POST" && url.pathname === "/api/retry") {
      const b = await body();
      try {
        const retries = retryCount(b.retries);
        const { stack, task } = stacks.resolve(String(b.id ?? b.taskId ?? ""));
        const failed = (task ? [task] : stack.tasks).filter((t) => t.status === "failed");
        if (!failed.length) throw new StackError(task ? `task ${task.id} is ${task.status}; only a failed task can be retried` : `stack ${stack.id} has no failed task`);
        const reasons = failed.map((t) => t.fail_reason ?? "");
        failed.forEach((t) => stacks.retry(t.id));
        try {
          return send(202, runner.start(stack.id, retries, failed.map((t) => t.id))), true;
        } catch (err) {
          failed.forEach((t, i) => stacks.fail(t.id, reasons[i]));
          throw err;
        }
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/limit") {
      return send(200, { limit: currentLimit(home), running: runner.count() }), true;
    }

    if (req.method === "POST" && url.pathname === "/api/limit") {
      const b = await body();
      try {
        const limit = setStackLimit(home, b.limit);
        log("info", "runner", "limit", { limit });
        return send(200, { limit, running: runner.count() }), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/idle") {
      return send(200, { running: runner.count(), proofs: proofs.size, busy: running.size }), true;
    }

    if (req.method === "POST" && url.pathname === "/api/resume-runs") {
      const b = await body();
      try {
        const r = resumeStopped(stacks, runner, retryCount(b.retries));
        return send(200, r), true;
      } catch (err) {
        return fail(err), true;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      const b = await body();
      const id = String(b.id ?? "");
      let target;
      try {
        target = stacks.resolve(id);
      } catch (err) {
        return fail(err), true;
      }
      const { stack, task } = target;
      if (b.afterTask) {
        const r = runner.stopAfterTask(stack.id);
        if (!r) return send(409, { error: `no run is active for stack ${stack.id}` }), true;
        log("info", "runner", "stop.after-task", { id, stack: stack.id, task: r.current });
        return send(200, { run: r, proofs: [], sessions: [], afterTask: true }), true;
      }
      const done = !task || runner.owns(task.id) ? runner.stop(stack.id) : null;
      const proof = (task ? [task] : stack.tasks).filter((t) => proofs.has(t.id));
      for (const x of proof) proofs.get(x.id)!.abort();
      const sessions = task && !done ? stopSessions(stacks.openSessionPids(task.id)) : [];
      if (!done && !proof.length && !sessions.length) return send(409, { error: `nothing runs for ${id}` }), true;
      log("info", "runner", "stop", { id, stack: stack.id, proofs: proof.map((x) => x.id), sessions });
      return send(200, { run: done ? await done : null, proofs: proof.map((x) => x.id), sessions }), true;
    }

    if (req.method === "POST" && url.pathname === "/api/sync") {
      await syncPrs();
      return send(200, { ok: true }), true;
    }

    return false;
  }

  return Object.assign(handle, { syncPrs });
}
