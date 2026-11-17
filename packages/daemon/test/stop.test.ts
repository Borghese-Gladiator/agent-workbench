import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks } from "../src/stacks.ts";
import { createApp } from "../src/server.ts";
import { createRunner, STOPPED, type Session } from "../src/runner.ts";
import { killChildren, run } from "../src/prove.ts";
import { stopSessions, taskRoutes } from "../src/task-routes.ts";

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

async function daemon() {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  const stacks = createStacks(store.db, (id) => `/tmp/awb-stop-test/${id}`);
  const waiting: Session = (_t, _b, signal) => new Promise((ok) => signal!.addEventListener("abort", () => ok("exit 143")));
  const runner = createRunner(stacks, () => waiting);
  const server = createApp(store, { home: "", startedAt: "" }, taskRoutes(stacks, {} as any, runner, () => null, "", store.db)).listen(0);
  await new Promise((r) => server.once("listening", r));
  const stop = async (id: string) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stop`, { method: "POST", body: JSON.stringify({ id }) });
    return [r.status, await r.json()] as const;
  };
  const close = () => (server.close(), store.close());
  return { store, stacks, runner, stop, close };
}

const tasks = [{ title: "A", claims: [{ id: "C1", text: "x" }] }, { title: "B", claims: [{ id: "C1", text: "y" }] }];

test("POST /api/stop with a stack id prefix stops the run; unknown and idle ids give 404 and 409", async () => {
  const d = await daemon();
  try {
    const { stack } = d.stacks.set({ repo: "/r", branch: "main", base: "main", tasks });
    assert.deepEqual((await d.stop(stack.tasks[1].id))[0], 409);
    assert.deepEqual((await d.stop("zzzzzzzz"))[0], 404);
    d.runner.start(stack.id);
    await new Promise((r) => setImmediate(r));
    const [status, body] = await d.stop(stack.id.slice(0, 8));
    assert.equal(status, 200);
    assert.deepEqual([body.run.state, body.run.reason], ["stopped", STOPPED]);
    assert.deepEqual(d.stacks.get(stack.id)!.tasks.map((t) => t.status), ["failed", "waiting"]);
  } finally {
    d.close();
  }
});

test("POST /api/stop with a task id sends SIGTERM to the open awb session of the task", async () => {
  const d = await daemon();
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)", "cli/src/main.ts"], { stdio: "ignore" });
  try {
    const [task] = d.stacks.set({ repo: "/r", branch: "main", base: "main", tasks: tasks.slice(0, 1) }).stack.tasks;
    const session = d.store.register({ id: "s1", repo: "/r", worktree: "/r", branch: "main", pid: child.pid });
    d.stacks.startAttempt(task.id, session.id);
    const [status, body] = await d.stop(task.id.slice(0, 8));
    assert.deepEqual([status, body.run, body.sessions], [200, null, [child.pid]]);
    await until(() => gone(child.pid!));
    assert.ok(gone(child.pid!));
  } finally {
    child.kill("SIGKILL");
    d.close();
  }
});

test("stopSessions skips a pid that is not an awb session", () => {
  assert.deepEqual(stopSessions([process.pid], () => false), []);
});

test("killChildren kills the process group of a running run()", async () => {
  const p = run("sh", ["-c", "sleep 30 & echo $!; wait"], "/");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(killChildren(), 1);
  const r = await p;
  await until(() => gone(Number(r.out.trim())));
  assert.ok(gone(Number(r.out.trim())));
  assert.equal(killChildren(), 0);
});
