import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks, parseSince, StackError } from "../src/stacks.ts";
import { createRunner, failReason, runStack, stackLimit, type RunState } from "../src/runner.ts";
import type { GateResult } from "../src/gate.ts";
import { carriedClaims } from "../src/task-routes.ts";

const setup = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  return createStacks(store.db, (id) => `/home/tasks/${id}`);
};
const t = (title: string) => ({ title, context: "c", description: "d", claims: [{ id: "C1", text: `${title} works` }, { id: "C2", text: "more" }] });
const gate = (pass: boolean): GateResult => ({
  pass,
  head: "abcdef1234567",
  reasons: [],
  rows: [
    { id: "C1", tests: 1, status: pass ? "PASS" : "FAIL", reasons: pass ? [] : ["not passed"], videos: [], traces: [] },
    { id: "C2", tests: 1, status: "PASS", reasons: [], videos: [], traces: [] },
  ],
});

test("parseSince takes 7d, 12h, 30m and a date, and refuses junk", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(parseSince("7d", now), "2026-10-23T12:00:00.000Z");
  assert.equal(parseSince("12h", now), "2026-10-30T00:00:00.000Z");
  assert.equal(parseSince("30m", now), "2026-10-30T11:30:00.000Z");
  assert.equal(parseSince("2026-10-01", now), "2026-10-01T00:00:00.000Z");
  assert.throws(() => parseSince("last week", now), StackError);
});

test("list filters by status and repo, and has the failed claims of the last gate", () => {
  const s = setup();
  const a = s.set({ repo: "/games", branch: "main", base: "main", tasks: [t("A"), t("B")] }).stack;
  const c = s.set({ repo: "/fender", branch: "x", base: "main", tasks: [t("C")] }).stack;
  const [ta] = a.tasks;
  const at = s.startAttempt(ta.id, null);
  s.saveGate(at, gate(false));
  s.fail(ta.id, "the gate failed");

  const failed = s.list({ status: ["failed"] });
  assert.deepEqual(failed.map((x) => [x.title, x.failed_claims, x.fail_reason, x.repo]), [["A", ["C1"], "the gate failed", "/games"]]);
  assert.deepEqual(s.list({ repo: "/fender" }).map((x) => x.id), [c.tasks[0].id]);
  assert.equal(s.list().length, 3);
  assert.deepEqual(s.list({ status: ["waiting", "failed"], repo: "/games" }).map((x) => x.title).sort(), ["A", "B"]);
  assert.equal(s.list({ since: "2999-01-01T00:00:00Z" }).length, 0);
});

test("find takes an id prefix of 6 or more characters", () => {
  const s = setup();
  const [x] = s.set({ repo: "/r", branch: "b", base: "main", tasks: [t("A")] }).stack.tasks;
  assert.equal(s.find(x.id.slice(0, 8))?.id, x.id);
  assert.equal(s.find("ffffffff-none"), undefined);
  assert.throws(() => s.find(x.id.slice(0, 3)), /6 or more/);
});

test("task rm removes waiting tasks, bumps the version and computes the bases again", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B"), t("C")] });
  const [a, b, c] = stack.tasks;
  assert.deepEqual(s.remove([b.id.slice(0, 8)]), [b.id]);
  const after = s.get(stack.id)!;
  assert.equal(after.version, 2);
  assert.deepEqual(after.tasks.map((x) => [x.id, x.position, x.base]), [[a.id, 0, "main"], [c.id, 1, a.branch]]);
});

test("task rm refuses all when one task has started", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B")] });
  const [a, b] = stack.tasks;
  s.setStatus(a.id, "doing");
  assert.throws(() => s.remove([b.id, a.id]), /only waiting or failed tasks can be removed/);
  assert.equal(s.get(stack.id)!.tasks.length, 2);
  assert.equal(s.get(stack.id)!.version, 1);
});

test("task rm removes a failed task with its attempts and gates", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B")] });
  const [a, b] = stack.tasks;
  s.saveGate(s.startAttempt(a.id, null), gate(false));
  s.fail(a.id, "the gate failed");
  assert.deepEqual(s.remove([a.id]), [a.id]);
  assert.deepEqual(s.get(stack.id)!.tasks.map((x) => [x.id, x.base]), [[b.id, "main"]]);
  assert.equal(s.history(a.id).length, 0);
});

test("runs lists the newest runs with the title of the current task", () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A")] });
  s.saveRun({ id: "r1", stackId: stack.id, state: "running", current: stack.tasks[0].id, reason: null });
  assert.equal(s.runs()[0].ended_at, null);
  s.saveRun({ id: "r1", stackId: stack.id, state: "stopped", current: stack.tasks[0].id, reason: "gate failed" });
  const [r] = s.runs();
  assert.deepEqual([r.id, r.state, r.title, r.repo, r.reason, typeof r.ended_at], ["r1", "stopped", "A", "/r", "gate failed", "string"]);
});

test("the runner saves the gate failure as the reason, and a retry clears it", async () => {
  const s = setup();
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [t("A"), t("B")] });
  const [a] = stack.tasks;
  const state: RunState = { id: "r", stackId: stack.id, state: "running", current: null, reason: null };
  const r = await runStack(s, stack.id, async (task) => s.saveGate(s.startAttempt(task.id, null), gate(false)), state);
  const reason = "the gate failed at abcdef1234: C1 not passed";
  assert.equal(r.reason, reason);
  assert.equal(s.task(a.id)!.fail_reason, reason);
  s.retry(a.id);
  assert.deepEqual([s.task(a.id)!.status, s.task(a.id)!.fail_reason], ["waiting", null]);
});

test("failReason without a gate, and with a pass but no ship", () => {
  const s = setup();
  const [a] = s.set({ repo: "/r", branch: "b", base: "main", tasks: [t("A")] }).stack.tasks;
  assert.match(failReason(s, a.id), /never ran awb prove/);
  s.saveGate(s.startAttempt(a.id, null), gate(true));
  assert.match(failReason(s, a.id), /without awb ship/);
});

test("the runner refuses a new stack when the limit is full, and the limit is never above 5", () => {
  const s = setup();
  const stacks = ["A", "B", "C"].map((title) => s.set({ repo: "/r", branch: title, base: "main", tasks: [t(title)] }).stack);
  const hold: (() => void)[] = [];
  const runner = createRunner(s, () => () => new Promise<void>((ok) => hold.push(ok)), { maxStacks: 2 });
  runner.start(stacks[0].id);
  runner.start(stacks[1].id);
  assert.equal(runner.start(stacks[0].id).stackId, stacks[0].id);
  assert.throws(() => runner.start(stacks[2].id), /2 stacks are running and the limit is 2/);
  hold.forEach((ok) => ok());
  assert.deepEqual([stackLimit(undefined), stackLimit("3"), stackLimit("10"), stackLimit("junk")], [2, 3, 5, 2]);
});

test("carriedClaims takes the test claims that passed in the last passing gate of each task below", () => {
  const s = setup();
  const tc = (title: string) => ({ title, context: "c", description: "d", claims: [{ id: "C1", text: "x", proof: "test" as const }, { id: "C2", text: "browser" }] });
  const { stack } = s.set({ repo: "/r", branch: "feat", base: "main", tasks: [tc("A"), tc("B"), tc("C")] });
  const [a, b, c] = stack.tasks;
  s.saveGate(s.startAttempt(a.id, null), gate(true));
  s.saveGate(s.startAttempt(b.id, null), gate(false));
  assert.deepEqual(carriedClaims(s, c), [{ label: "T1", claims: [a.claims[0]], folder: a.folder }]);
  assert.deepEqual(carriedClaims(s, a), []);
});

test("POST /api/run and /api/retry accept a stack or a task id and pass targets to the runner", async () => {
  const { createApp } = await import("../src/server.ts");
  const { taskRoutes } = await import("../src/task-routes.ts");
  const store = openStore(":memory:");
  migrateStacks(store.db);
  const s = createStacks(store.db, (id) => `/home/tasks/${id}`);
  const [a, b, c] = s.set({ repo: "/r", branch: "main", base: "main", tasks: [t("A"), t("B"), t("C")] }).stack.tasks;
  const calls: (string[] | undefined)[] = [];
  const runner = { start: (stackId: string, retries: number, targets?: string[]) => (calls.push(targets), { id: "run", stackId, state: "running", current: null, reason: null, retries }) };
  const server = createApp(store, { home: "", startedAt: "" }, taskRoutes(s, {} as any, runner as any, () => null, "", store.db)).listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = async (path: string, body: object) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method: "POST", body: JSON.stringify(body) });
    return [r.status, await r.json()] as const;
  };
  try {
    const [blocked, err] = await post("/api/run", { id: b.id });
    assert.deepEqual([blocked, err.error.includes(a.id)], [409, true]);
    assert.equal((await post("/api/run", { id: a.id }))[0], 202);
    assert.equal((await post("/api/run", { id: a.stack_id }))[0], 202);
    s.setStatus(a.id, "done");
    assert.equal((await post("/api/run", { id: b.id }))[0], 202);
    s.setStatus(b.id, "doing");
    assert.equal((await post("/api/run", { id: b.id }))[0], 409);
    assert.deepEqual(calls, [[a.id], undefined, [b.id]]);

    assert.equal((await post("/api/retry", { id: a.stack_id }))[0], 409);
    s.fail(b.id, "x");
    s.fail(c.id, "y");
    assert.equal((await post("/api/retry", { id: a.id }))[0], 409);
    assert.equal((await post("/api/retry", { id: a.stack_id }))[0], 202);
    assert.deepEqual(calls.at(-1), [b.id, c.id]);
    assert.deepEqual(s.get(a.stack_id)!.tasks.map((x) => x.status), ["done", "waiting", "waiting"]);
  } finally {
    server.close();
    store.close();
  }
});

test("POST /api/run and /api/retry pass retries to the runner, and refuse a bad value", async () => {
  const { createApp } = await import("../src/server.ts");
  const { taskRoutes } = await import("../src/task-routes.ts");
  const store = openStore(":memory:");
  migrateStacks(store.db);
  const s = createStacks(store.db, (id) => `/home/tasks/${id}`);
  const [task] = s.set({ repo: "/r", branch: "main", base: "main", tasks: [t("A")] }).stack.tasks;
  const started: number[] = [];
  const runner = { start: (stackId: string, retries: number) => (started.push(retries), { id: "run", stackId, state: "running", current: null, reason: null, retries }) };
  const server = createApp(store, { home: "", startedAt: "" }, taskRoutes(s, {} as any, runner as any, () => null, "", store.db)).listen(0);
  await new Promise((r) => server.once("listening", r));
  const post = async (path: string, body: object) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method: "POST", body: JSON.stringify(body) });
    return [r.status, await r.json()] as const;
  };
  try {
    assert.deepEqual(await post("/api/run", { repo: "/r" }), [202, { id: "run", stackId: task.stack_id, state: "running", current: null, reason: null, retries: 1 }]);
    assert.equal((await post("/api/run", { repo: "/r", retries: "3" }))[1].retries, 3);
    const [bad, err] = await post("/api/run", { repo: "/r", retries: "9" });
    assert.deepEqual([bad, err.error], [400, "retries must be an integer from 0 to 5, not 9"]);
    s.fail(task.id, "x");
    assert.equal((await post("/api/retry", { taskId: task.id, retries: "x" }))[0], 400);
    assert.equal(s.task(task.id)!.status, "failed");
    assert.equal((await post("/api/retry", { taskId: task.id, retries: 0 }))[0], 202);
    assert.deepEqual(started, [1, 3, 0]);
  } finally {
    server.close();
    store.close();
  }
});
