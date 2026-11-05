import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceOf, usageCost } from "../src/prices.ts";
import { tokenTotals } from "../src/usage.ts";
import { openStore } from "../src/store.ts";
import { createStacks, migrateStacks } from "../src/stacks.ts";
import { lastSessionUsd, runStack, sessionEnd, type RunState } from "../src/runner.ts";
import { writerEnd } from "../src/prove.ts";
import { runGate } from "../src/gate.ts";
import { costReport, costText } from "../src/cost.ts";
import { runMessage } from "../src/notify.ts";
import { createLog, readLog } from "../src/log.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "awb-obs-"));
const setup = (file = ":memory:", opts = {}) => {
  const store = openStore(file, opts);
  migrateStacks(store.db);
  const root = tmp();
  return { store, stacks: createStacks(store.db, (id) => join(root, id)) };
};
const where = { repo: "/r", branch: "main", base: "main" };
const two = ["A", "B"].map((title) => ({ title, claims: [{ id: "C1", text: `${title} works` }] }));
const state = (stackId: string): RunState => ({ id: "run-1", stackId, state: "running", current: null, reason: null });

test("prices: a known model, a dated id by prefix, and no cost for an unknown model", () => {
  assert.deepEqual(priceOf("claude-opus-5-5"), { input: 4, output: 20, cacheRead: 0.2 });
  assert.equal(priceOf("claude-opus-5-5-20261001")?.input, 4);
  assert.equal(priceOf("claude-opus-5")?.input, 5, "the longer id does not shadow the shorter one");
  assert.equal(priceOf("gpt-5"), null);
  const usd = usageCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  assert.equal(usd!.toFixed(4), (2 + 1 + 0.2).toFixed(4));
});

test("tokenTotals gives cost_usd from the model of each message", () => {
  const file = join(tmp(), "t.jsonl");
  const msg = (id: string, model: string) => JSON.stringify({ message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
  writeFileSync(file, [msg("a", "claude-haiku-5-5"), msg("b", "claude-opus-5-5")].join("\n"));
  assert.equal(tokenTotals(file).cost_usd!.toFixed(2), "4.10");
  writeFileSync(file, [msg("a", "claude-haiku-5-5"), msg("b", "some-other-model")].join("\n"));
  assert.equal(tokenTotals(file).cost_usd, null, "one unpriced message makes the session unpriced");
});

test("a session with no event for the quiet time is quiet, and a dead awb process is lost", () => {
  const quiet = openStore(":memory:", { quietMs: -1 });
  quiet.register({ id: "s", repo: "/r", worktree: "/r", branch: "main", pid: process.pid });
  assert.equal(quiet.feedRow("s")!.state, "quiet");
  const lost = openStore(":memory:", { isAlive: () => false });
  lost.register({ id: "s", repo: "/r", worktree: "/r", branch: "main", pid: 999999 });
  assert.equal(lost.feedRow("s")!.state, "lost");
  lost.end("s", 0);
  assert.equal(lost.feedRow("s")!.state, "ended");
});

test("sessionEnd and writerEnd name a timeout, a result subtype and an exit code", () => {
  const result = (subtype: string) => JSON.stringify({ type: "result", subtype, num_turns: 3, total_cost_usd: 1.25 });
  assert.equal(sessionEnd("", true, null, 45), "timeout after 45 min");
  assert.equal(sessionEnd(result("error_max_turns"), false, 1, 45), "error_max_turns");
  assert.equal(sessionEnd(result("success"), false, 0, 45), "");
  assert.equal(sessionEnd("", false, 137, 45), "exit 137");
  assert.deepEqual(writerEnd(result("success"), false, 0, 30), { end: "success, 3 turns", usd: 1.25 });
  assert.deepEqual(writerEnd("partial output", true, 143, 30), { end: "timeout after 30 min", usd: null });
});

test("the gate gives the writer end as the cause of a missing test", () => {
  const g = runGate({ claims: [{ id: "C1", text: "x" }], report: { suites: [] }, head: "h", savedSha: "h", dirty: false, testHashAtStart: "a", testHashNow: "a", fileExists: () => true, writerEnd: "timeout after 30 min" });
  assert.deepEqual(g.rows[0].reasons, ["no test (test writer: timeout after 30 min)"]);
});

test("runStack puts how the session ended in the reason, logs it and saves the run", async () => {
  const { stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const dir = tmp();
  const r = await runStack(stacks, stack.id, async () => "timeout after 1 min", state(stack.id), { log: createLog(dir) });
  assert.equal(r.state, "stopped");
  assert.match(r.reason!, /never ran awb prove \(session: timeout after 1 min\)$/);
  assert.equal(stacks.task(stack.tasks[0].id)!.fail_reason, r.reason);
  assert.deepEqual(stacks.run("run-1"), { id: "run-1", stackId: stack.id, state: "stopped", current: stack.tasks[0].id, reason: r.reason });
  const lines = readLog(dir, { task: stack.tasks[0].id });
  assert.deepEqual(lines.map((l) => `${l.level} ${l.source}.${l.event}`), ["info runner.session.start", "warn runner.session.ended", "error runner.task.failed"]);
  assert.equal(lines[1].how, "timeout after 1 min");
  assert.equal(lines[2].reason, r.reason);
  assert.ok(lines.every((l) => l.run === "run-1" && l.repo === "/r"));
});

test("after a restart, recover stops a running run and fails a doing task", () => {
  const file = join(tmp(), "awb.db");
  const a = setup(file);
  const { stack } = a.stacks.set({ ...where, tasks: two });
  a.stacks.saveRun({ ...state(stack.id), current: stack.tasks[0].id });
  a.stacks.setStatus(stack.tasks[0].id, "doing");
  a.store.close();

  const b = setup(file);
  assert.deepEqual(b.stacks.recover(), { runs: 1, tasks: [stack.tasks[0].id], alive: [] });
  assert.equal(b.stacks.run("run-1")!.state, "stopped");
  assert.equal(b.stacks.run("run-1")!.reason, "daemon restart");
  assert.equal(b.stacks.task(stack.tasks[0].id)!.status, "failed");
  assert.deepEqual(b.stacks.recover(), { runs: 0, tasks: [], alive: [] }, "a second recover changes nothing");
});

test("the cost report adds sessions and writers by day, repo and task, and counts unpriced sessions", () => {
  const { store, stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const [t1] = stack.tasks;
  store.register({ id: "task-session", repo: "/r", worktree: "/w", branch: t1.branch! });
  store.setUsage("task-session", { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 1.5 });
  const a1 = stacks.startAttempt(t1.id, "task-session");
  const a2 = stacks.startAttempt(t1.id, "task-session");
  stacks.setWriterCost(a1, 0.75);
  stacks.setWriterCost(a2, 0.25);
  store.register({ id: "chat", repo: "/other", worktree: "/other", branch: "main" });
  store.setUsage("chat", { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0.5 });
  store.register({ id: "unpriced", repo: "/r", worktree: "/r", branch: "main" });
  store.setUsage("unpriced", { input: 9, output: 9, cache_read: 0, cache_creation: 0, cost_usd: null });

  const r = costReport(store.db, "");
  assert.equal(r.total_usd, 3);
  assert.equal(r.session_usd, 2, "a session with two attempts counts once");
  assert.equal(r.writer_usd, 1);
  assert.deepEqual(r.by_repo, { "/r": 2.5, "/other": 0.5 });
  assert.deepEqual(r.by_task, [{ task_id: t1.id, title: "A", usd: 2.5 }]);
  assert.equal(r.unpriced_sessions, 1);
  assert.equal(costReport(store.db, "", "/other").total_usd, 0.5);
  assert.equal(costReport(store.db, "2999-01-01T00:00:00Z").total_usd, 0, "since filters the rows");

});

test("the run notice names the repo, the task and the reason", () => {
  const { stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const m = runMessage(stacks, { id: "x", stackId: stack.id, state: "stopped", current: stack.tasks[0].id, reason: "timeout" });
  assert.deepEqual(m, { title: "awb: r stack stopped", body: "A: timeout" });
  assert.equal(runMessage(stacks, { id: "x", stackId: stack.id, state: "done", current: null, reason: null }).body, "2 task(s) shipped");
});

test("the cost report filters by repo name or path, and the text form lists day, repo and task", () => {
  const { store, stacks } = setup();
  const { stack } = stacks.set({ repo: "/src/games", branch: "main", base: "main", tasks: two });
  store.register({ id: "s1", repo: "/src/games", worktree: "/w", branch: "x" });
  store.setUsage("s1", { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 1.25 });
  stacks.setWriterCost(stacks.startAttempt(stack.tasks[0].id, "s1"), 0.5);
  store.register({ id: "s2", repo: "/src/other", worktree: "/o", branch: "main" });
  store.setUsage("s2", { input: 1, output: 1, cache_read: 0, cache_creation: 0, cost_usd: null });

  assert.equal(costReport(store.db, "", "games").total_usd, 1.75);
  assert.equal(costReport(store.db, "", "/src/games").total_usd, 1.75);
  assert.equal(costReport(store.db, "", "games").unpriced_sessions, 0, "the unpriced count follows the repo filter");
  assert.equal(costReport(store.db, "", "other").unpriced_sessions, 1);

  const text = costText(costReport(store.db, ""));
  assert.match(text, /^cost since .* \(estimate from token counts\)\ntotal 1\.75 USD: task and chat sessions 1\.25 USD, test writer 0\.50 USD/);
  assert.match(text, /by repo:\n +1\.75 USD {2}games/);
  assert.match(text, new RegExp(`top tasks:\\n +1\\.75 USD {2}${stack.tasks[0].id.slice(0, 8)} {2}A`));
  assert.match(text, /1 session\(s\) have no price/);
  assert.match(costText(costReport(store.db, "2999-01-01")), /no cost in this period/);
});

test("lastSessionUsd reads the newest session file by number, and the runner logs it on session.ended", async () => {
  const folder = tmp();
  assert.equal(lastSessionUsd(join(folder, "nope")), null);
  const result = (usd: number) => [JSON.stringify({ type: "assistant" }), JSON.stringify({ type: "result", subtype: "success", total_cost_usd: usd })].join("\n");
  writeFileSync(join(folder, "session-9.jsonl"), result(9));
  writeFileSync(join(folder, "session-10.jsonl"), result(0.5) + "\n" + result(0.75));
  assert.equal(lastSessionUsd(folder), 0.75, "session-10 is newer than session-9, and its last running total counts");

  const { stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const task = stack.tasks[0];
  mkdirSync(task.folder, { recursive: true });
  writeFileSync(join(task.folder, "session-1.jsonl"), result(1.2));
  const dir = tmp();
  await runStack(stacks, stack.id, async () => "", state(stack.id), { log: createLog(dir), sessionUsd: (t) => lastSessionUsd(t.folder) });
  const ended = readLog(dir, { task: task.id }).find((l) => l.event === "session.ended")!;
  assert.equal(ended.usd, 1.2);
});

test("a stream with a result row uses its usage and total_cost_usd, and a 1h cache write costs 2x input", () => {
  const file = join(tmp(), "s.jsonl");
  const partial = { input_tokens: 2, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 44541 };
  const final = { input_tokens: 30, output_tokens: 4251, cache_read_input_tokens: 738580, cache_creation_input_tokens: 57153, cache_creation: { ephemeral_1h_input_tokens: 57153, ephemeral_5m_input_tokens: 0 } };
  writeFileSync(file, [
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: partial } }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.69008, usage: final }),
  ].join("\n"));
  assert.deepEqual(tokenTotals(file), { input: 30, output: 4251, cache_read: 738580, cache_creation: 57153, cost_usd: 0.69008 });
  assert.equal(usageCost("claude-opus-5-5", final)!.toFixed(5), "0.69008", "the price table gives the same cost as claude");
  assert.equal(usageCost("claude-opus-5-5", { ...final, cache_creation: { ephemeral_5m_input_tokens: 57153, ephemeral_1h_input_tokens: 0 } })!.toFixed(5), "0.51862", "a 5m cache write costs 1.25x input");
});

test("recover keeps a doing task whose session is still running, and fails one whose session is gone", () => {
  const { store, stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const [t1, t2] = stack.tasks;
  store.register({ id: "live", repo: "/r", worktree: "/w1", branch: t1.branch!, pid: 111 });
  store.register({ id: "dead", repo: "/r", worktree: "/w2", branch: t2.branch!, pid: 222 });
  stacks.startAttempt(t1.id, "live");
  stacks.startAttempt(t2.id, "dead");
  stacks.setStatus(t1.id, "doing");
  stacks.setStatus(t2.id, "doing");
  assert.deepEqual(stacks.recover((pid) => pid === 111), { runs: 0, tasks: [t2.id], alive: [t1.id] });
  assert.equal(stacks.task(t1.id)!.status, "doing");
  assert.equal(stacks.task(t2.id)!.status, "failed");
  store.end("live", 0);
  assert.deepEqual(stacks.recover((pid) => pid === 111), { runs: 0, tasks: [t1.id], alive: [] }, "an ended session does not count, even if its pid is reused");
});

test("a shipped task does not keep an old fail reason", () => {
  const { stacks } = setup();
  const { stack } = stacks.set({ ...where, tasks: two });
  const t = stack.tasks[0];
  stacks.fail(t.id, "the daemon restarted while the task ran");
  stacks.setPr(t.id, 64, "https://github.com/o/r/pull/64");
  const after = stacks.task(t.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.fail_reason, null);
});
