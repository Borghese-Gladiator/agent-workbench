import test from "node:test";
import assert from "node:assert/strict";
import { needsAttention, prGroup, stackProgress, timeline } from "../ui/select.ts";

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
