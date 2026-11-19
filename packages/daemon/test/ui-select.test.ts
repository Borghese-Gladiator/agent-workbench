import test from "node:test";
import assert from "node:assert/strict";
import { barRows, costlyFailures, filterTasks, lastGate, matchLines, needsAttention, prGroup, stackCost, stackProgress, stepStates, timeline, toneOf } from "../ui/select.ts";

test("toneOf maps a status to a tone, and an unknown status to dim", () => {
  assert.deepEqual(["done", "failed", "doing", "waiting", "zzz"].map(toneOf), ["ok", "bad", "warn", "dim", "dim"]);
});

test("stepStates: done, the running task, a failed task, then blocked tasks after it", () => {
  const s = (status: string) => ({ status });
  assert.deepEqual(stepStates([s("merged"), s("done"), s("failed"), s("waiting")]), ["done", "done", "failed", "blocked"]);
  assert.deepEqual(stepStates([s("done"), s("doing"), s("waiting")]), ["done", "running", "waiting"]);
});

test("filterTasks matches the text in title, branch, repo and id, and the status", () => {
  const tasks = [{ id: "a1", title: "Footer", branch: "awb/f", repo: "/r/demo", status: "failed" }, { id: "b2", title: "Header", branch: "awb/h", repo: "/r/demo", status: "done" }];
  assert.deepEqual(filterTasks(tasks, "foot", "all").map((t) => t.id), ["a1"]);
  assert.deepEqual(filterTasks(tasks, "", "done").map((t) => t.id), ["b2"]);
  assert.equal(filterTasks(tasks, "DEMO", "all").length, 2);
});

test("matchLines searches every field of a log line, ignoring case", () => {
  const lines = [{ event: "gate", reason: "C2 Not Passed" }, { event: "start" }];
  assert.equal(matchLines(lines, "not passed").length, 1);
  assert.equal(matchLines(lines, "  ").length, 2);
  assert.equal(matchLines([{ source: "runner", event: "task.failed" }], "runner.task.failed").length, 1);
});

test("barRows sorts by cost, scales to the top row, and keeps the limit", () => {
  assert.deepEqual(barRows({ a: 1, b: 4, c: 2 }, 2), [{ name: "b", usd: 4, pct: 100 }, { name: "c", usd: 2, pct: 50 }]);
  assert.deepEqual(barRows({}), []);
});

test("lastGate gives the newest gate of the last attempt, or null", () => {
  assert.equal(lastGate({ attempts: [] }), null);
  assert.equal(lastGate({ attempts: [{ gates: [{ n: 1 }] }, { gates: [{ n: 2 }, { n: 3 }] }] })?.n, 3);
});

test("stackCost sums task cost, and costlyFailures flags only failed tasks above twice the average", () => {
  const usd = { a: 1, b: 1, c: 10 };
  const tasks = [{ id: "a", status: "done" }, { id: "b", status: "failed" }, { id: "c", status: "failed" }, { id: "d", status: "done" }];
  assert.equal(stackCost(tasks, usd), 12);
  assert.deepEqual([...costlyFailures(tasks, usd)], ["c"]);
});

const t = (o: object) => ({ id: "x", stack_id: "s", position: 0, status: "done", failed_claims: [], last_gate_at: "now", ...o });

test("needsAttention lists failed tasks and open PRs with a failed gate", () => {
  const out = needsAttention([t({ id: "a", status: "failed", fail_reason: "timeout" }), t({ id: "b", failed_claims: ["C1"] }), t({ id: "c" }), t({ id: "d", status: "waiting" })]);
  assert.deepEqual(out.map((x) => [x.task.id, x.reason]), [["a", "timeout"], ["b", "Gate failed for C1."]]);
});

test("prGroup: no gate or a failed claim blocks; an unmerged earlier task waits; else review", () => {
  const all = [t({ id: "1", position: 0, status: "done" }), t({ id: "2", position: 1 }), t({ id: "3", position: 0, stack_id: "o" })];
  assert.equal(prGroup(t({ last_gate_at: null }), all), "blocked");
  assert.equal(prGroup(t({ failed_claims: ["C1"] }), all), "blocked");
  assert.equal(prGroup(all[1], all), "waiting");
  assert.equal(prGroup(all[0], all), "review");
  assert.equal(prGroup(all[1], [{ ...all[0], status: "merged" }, all[1]]), "review");
});

test("stackProgress counts done and merged tasks and finds the doing task", () => {
  const p = stackProgress([t({ status: "merged" }), t({ status: "done" }), t({ id: "w", status: "doing" }), t({ status: "waiting" })]);
  assert.equal(p.finished, 2);
  assert.equal(p.total, 4);
  assert.equal(p.current?.id, "w");
});

test("timeline keeps lines at or above the level and names known events", () => {
  const out = timeline([{ ts: "1", level: "info", source: "a", event: "b" }, { ts: "2", level: "error", source: "runner", event: "task.failed", reason: "x" }]);
  assert.deepEqual(out.map((s) => [s.title, s.detail]), [["Task failed", "reason=x"]]);
});
