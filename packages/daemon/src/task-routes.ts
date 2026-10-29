import type { IncomingMessage, ServerResponse } from "node:http";
import { StackError, validateTasks, type Stacks } from "./stacks.ts";
import { prove, run, type ProveDeps } from "./prove.ts";
import { ship, ShipRefused, syncStatus } from "./ship.ts";

type Json = Record<string, any>;

export function taskRoutes(stacks: Stacks, proveDeps: Omit<ProveDeps, "log">) {
  const proving = new Set<string>();

  async function syncPrs() {
    for (const t of stacks.shipped()) {
      const r = await run("gh", ["pr", "view", String(t.pr_number), "--json", "state"], t.repo);
      if (r.code !== 0) continue;
      const next = syncStatus(JSON.parse(r.out).state);
      if (next) stacks.setStatus(t.id, next);
    }
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
      else send(200, { ...t, stack: stacks.get(t.stack_id), attempts: stacks.history(t.id) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/prove") {
      const b = await body();
      const t = stacks.taskForBranch(b.repo ?? "", b.branch ?? "");
      if (!t) return send(404, { error: "no task on this branch; run awb stack set first" }), true;
      if (!["waiting", "doing", "failed"].includes(t.status)) return send(409, { error: `task ${t.id} is ${t.status}` }), true;
      if (proving.has(t.id)) return send(409, { error: `a proof run for task ${t.id} is already running` }), true;

      proving.add(t.id);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (o: Json) => res.write(JSON.stringify(o) + "\n");
      stacks.setStatus(t.id, "doing");
      const attempt = stacks.startAttempt(t.id, typeof b.sessionId === "string" ? b.sessionId : null);
      try {
        const r = await prove(t, b.worktree, { ...proveDeps, log: (msg) => line({ log: msg }) });
        stacks.saveGate(attempt, r.gate);
        line({ result: { pass: r.gate.pass, table: r.table, rows: r.gate.rows, folder: r.folder, taskId: t.id } });
      } catch (err) {
        line({ error: (err as Error).message });
      } finally {
        stacks.endAttempt(attempt);
        proving.delete(t.id);
        res.end();
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ship") {
      const b = await body();
      const t = stacks.taskForBranch(b.repo ?? "", b.branch ?? "");
      if (!t) return send(404, { error: "no task on this branch; run awb stack set first" }), true;
      if (!["waiting", "doing", "failed"].includes(t.status)) return send(409, { error: `task ${t.id} is ${t.status}: ${t.pr_url}` }), true;
      if (proving.has(t.id)) return send(409, { error: `a proof run or ship for task ${t.id} is already running` }), true;

      proving.add(t.id);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (o: Json) => res.write(JSON.stringify(o) + "\n");
      try {
        const r = await ship(t, b.worktree, (msg) => line({ log: msg }));
        stacks.setPr(t.id, r.number, r.url);
        line({ result: { url: r.url, number: r.number, table: r.table, taskId: t.id } });
      } catch (err) {
        line({ error: (err as Error).message, table: err instanceof ShipRefused ? err.table : undefined });
      } finally {
        proving.delete(t.id);
        res.end();
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/sync") {
      await syncPrs();
      return send(200, { ok: true }), true;
    }

    return false;
  }

  return Object.assign(handle, { syncPrs });
}
