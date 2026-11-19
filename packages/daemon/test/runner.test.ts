import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks, taskBranch } from "../src/stacks.ts";
import { createRunner, initSessionId, retryCount, runStack, sessionEnd, STOPPED, taskPrompt, transientError, type RunState, type Session } from "../src/runner.ts";
import { run } from "../src/prove.ts";

const setup = () => {
  const store = openStore(":memory:");
  migrateStacks(store.db);
  return createStacks(store.db, (id) => `/home/tasks/${id}`);
};
const where = { repo: "/r", branch: "main", base: "main" };
const three = ["Accounts", "Save results", "Leaderboard"].map((title) => ({ title, claims: [{ id: "C1", text: `${title} works` }] }));
const state = (stackId: string): RunState => ({ id: "run", stackId, state: "running", current: null, reason: null });

test("a stack of three: one branch for each task, and the bases form a chain", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  assert.equal(a.branch, taskBranch("Accounts", a.id));
  assert.match(a.branch!, /^awb\/accounts-[0-9a-f]{6}$/);
  assert.deepEqual([a.base, b.base, c.base], ["main", a.branch, b.branch]);
  assert.equal(stack.base, "main");
});

test("a replace that moves a waiting task computes the bases again", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  const r = s.set({ ...where, stackId: stack.id, version: 1, tasks: [a, c, b].map(({ id, title, claims }) => ({ id, title, claims })) });
  const [x, y, z] = r.stack.tasks;
  assert.deepEqual([x.id, y.id, z.id], [a.id, c.id, b.id]);
  assert.deepEqual([x.base, y.base, z.base], ["main", a.branch, c.branch]);
});

test("a new task in a replace gets its own branch on top", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three.slice(0, 2) });
  const r = s.set({ ...where, stackId: stack.id, version: 1, tasks: [...stack.tasks.map(({ id, title, claims }) => ({ id, title, claims })), three[2]] });
  const [, b, c] = r.stack.tasks;
  assert.match(c.branch!, /^awb\/leaderboard-/);
  assert.equal(c.base, b.branch);
});

const shipping = (s: ReturnType<typeof setup>, fail: Set<string>, seen: string[]): Session => async (task) => {
  seen.push(task.title);
  if (!fail.has(task.title)) s.setPr(task.id, seen.length, `https://gh/pr/${seen.length}`);
};

test("the runner does all three tasks in order", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const seen: string[] = [];
  const r = await runStack(s, stack.id, shipping(s, new Set(), seen), state(stack.id));
  assert.deepEqual(seen, ["Accounts", "Save results", "Leaderboard"]);
  assert.equal(r.state, "done");
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["done", "done", "done"]);
});

test("a task with no PR fails and stops the stack; a retry continues it", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const seen: string[] = [];
  const fail = new Set(["Save results"]);
  const r = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.deepEqual(seen, ["Accounts", "Save results"]);
  assert.equal(r.state, "stopped");
  assert.equal(r.current, stack.tasks[1].id);
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["done", "failed", "waiting"]);

  const again = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.equal(again.state, "stopped", "a failed task is not run again without a retry");
  assert.equal(seen.length, 2);

  fail.clear();
  s.setStatus(stack.tasks[1].id, "waiting");
  const retry = await runStack(s, stack.id, shipping(s, fail, seen), state(stack.id));
  assert.deepEqual(seen.slice(2), ["Save results", "Leaderboard"]);
  assert.equal(retry.state, "done");
});

test("a run with targets stops when the listed tasks are done, and refuses to pass an unlisted waiting task", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b] = stack.tasks;
  const seen: string[] = [];
  const first = await runStack(s, stack.id, shipping(s, new Set(), seen), state(stack.id), { targets: [a.id] });
  assert.deepEqual([first.state, seen], ["done", ["Accounts"]]);
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["done", "waiting", "waiting"]);

  const skip = await runStack(s, stack.id, shipping(s, new Set(), seen), state(stack.id), { targets: [stack.tasks[2].id] });
  assert.equal(skip.state, "stopped");
  assert.equal(skip.current, b.id);
  assert.deepEqual(seen, ["Accounts"]);
});

test("a session that throws marks the task failed with the reason", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const r = await runStack(s, stack.id, async () => { throw new Error("git worktree add failed"); }, state(stack.id));
  assert.equal(r.reason, "git worktree add failed");
  assert.equal(s.get(stack.id)!.tasks[0].status, "failed");
});

for (const [line, hit] of [
  ["API Error: 529 overloaded_error", "API Error: 529"],
  ["API Error: 500 Internal server error", "API Error: 500"],
  ["API Error: 429 rate_limit_error", "API Error: 429"],
  ["API Error: Connection error.", "Connection error"],
  ["connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"],
  ["read ECONNRESET", "ECONNRESET"],
  ["TypeError: fetch failed", "fetch failed"],
  ["API Error: 400 invalid_request_error", null],
  ["API Error: 401 authentication_error", null],
  ["error_max_turns", null],
  ["", null],
] as const) {
  test(`transientError(${JSON.stringify(line)}) is ${hit}`, () => {
    assert.equal(transientError(line), hit);
  });
}

test("sessionEnd names a transient error from the result line, and initSessionId reads the init line", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "claude-1" });
  const tool = JSON.stringify({ type: "user", content: "curl: ECONNREFUSED" });
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" });
  const api = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" });
  assert.equal(sessionEnd([init, tool, ok].join("\n"), false, 0, 45), "");
  assert.equal(sessionEnd([init, api].join("\n"), false, 1, 45), "exit 1: API Error: 529");
  assert.equal(sessionEnd("TypeError: fetch failed", false, 1, 45), "exit 1: fetch failed");
  assert.equal(initSessionId([init, api].join("\n")), "claude-1");
  assert.equal(initSessionId(api), null);
});

for (const [v, n] of [[undefined, 1], [0, 0], ["3", 3], [5, 5], ["6", null], [-1, null], ["1.5", null], ["x", null], ["", null]] as const) {
  test(`retryCount(${JSON.stringify(v)}) is ${n ?? "an error"}`, () => {
    if (n === null) assert.throws(() => retryCount(v), /retries must be an integer from 0 to 5/);
    else assert.equal(retryCount(v), n);
  });
}

for (const [retries, want] of [[1, "done"], [0, "stopped"]] as const) {
  test(`a transient error on the first session gives ${want} with retries ${retries}`, async () => {
    const s = setup();
    const { stack } = s.set({ ...where, tasks: three.slice(0, 1) });
    const calls: boolean[] = [];
    const flaky: Session = async (task, _below, resume = false) => {
      calls.push(resume);
      if (calls.length === 1) return "exit 1: API Error: 529";
      s.setPr(task.id, 1, "https://gh/pr/1");
    };
    const r = await runStack(s, stack.id, flaky, { ...state(stack.id), retries });
    assert.equal(r.state, want);
    assert.deepEqual(calls, retries ? [false, true] : [false]);
    if (!retries) assert.match(r.reason!, /session: exit 1: API Error: 529/);
  });
}

test("a session that fails without a transient error is not retried", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three.slice(0, 1) });
  let calls = 0;
  const r = await runStack(s, stack.id, async () => (calls++, "error_max_turns"), { ...state(stack.id), retries: 3 });
  assert.equal(r.state, "stopped");
  assert.equal(calls, 1);
});

test("the task prompt has the claims and the titles of the tasks below", () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const [a, b, c] = stack.tasks;
  const p = taskPrompt(c, [a, b]);
  assert.match(p, /"Leaderboard"/);
  assert.match(p, /- C1: Leaderboard works/);
  assert.match(p, /below this one are done.*"Accounts", "Save results"/);
  assert.match(p, new RegExp(`branch ${c.branch}`));
  assert.match(taskPrompt(a, []), /first task of the stack/);
});

test("stop fails the current task with the reason, and the later tasks stay waiting", async () => {
  const s = setup();
  const { stack } = s.set({ ...where, tasks: three });
  const started: string[] = [];
  const waiting: Session = (task, _below, _resume, signal) => {
    started.push(task.title);
    return new Promise((ok) => signal!.addEventListener("abort", () => ok("exit 143")));
  };
  const runner = createRunner(s, () => waiting);
  runner.start(stack.id);
  await new Promise((ok) => setImmediate(ok));
  const r = await runner.stop(stack.id)!;
  assert.deepEqual([r.state, r.reason, started], ["stopped", STOPPED, ["Accounts"]]);
  assert.equal(s.task(stack.tasks[0].id)!.fail_reason, STOPPED);
  assert.deepEqual(s.get(stack.id)!.tasks.map((t) => t.status), ["failed", "waiting", "waiting"]);
  assert.equal(runner.stop(stack.id), null);
});

test("run() with an aborted signal kills the child and its group", async () => {
  const ctrl = new AbortController();
  const p = run("sh", ["-c", "sleep 30 & echo $!; wait"], "/", "", 0, ctrl.signal);
  await new Promise((ok) => setTimeout(ok, 300));
  ctrl.abort();
  const r = await p;
  const pid = Number(r.out.trim());
  assert.notEqual(r.code, 0);
  assert.throws(() => process.kill(pid, 0));
});
