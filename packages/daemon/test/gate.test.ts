import { test } from "node:test";
import assert from "node:assert/strict";
import { runGate, type GateInput, type ReportSpec } from "../src/gate.ts";

const spec = (title: string, over: Partial<ReportSpec["tests"][0]> = {}, attachments = ["video", "trace"]): ReportSpec => ({
  title,
  tests: [{ status: "expected", results: [{ status: "passed", attachments: attachments.map((name) => ({ name, path: `/p/${title}/${name}` })) }], ...over }],
});

const base = (specs: ReportSpec[], over: Partial<GateInput> = {}): GateInput => ({
  claims: [{ id: "C1", text: "a" }, { id: "C2", text: "b" }],
  report: { suites: [{ suites: [{ specs }] }] },
  head: "abc",
  savedSha: "abc",
  dirty: false,
  testHashAtStart: "h",
  testHashNow: "h",
  fileExists: () => true,
  ...over,
});

const good = [spec("C1: a"), spec("C2: b")];

test("all rules hold: the gate passes and lists the evidence", () => {
  const g = runGate(base(good));
  assert.equal(g.pass, true);
  assert.deepEqual(g.rows.map((r) => r.status), ["PASS", "PASS"]);
  assert.deepEqual(g.rows[0].videos, ["/p/C1: a/video"]);
});

for (const [name, input, reason, failed] of [
  ["no test for a claim", base([spec("C1: a")]), "no test", ["C2"]],
  ["a claim id only as a prefix of another", base([spec("C1: a"), spec("C22: b")]), "no test", ["C2"]],
  ["a skipped test", base([spec("C1: a"), spec("C2: b", { status: "skipped" })]), "skipped", ["C2"]],
  ["a fixme test", base([spec("C1: a"), spec("C2: b", { annotations: [{ type: "fixme" }] })]), "skipped", ["C2"]],
  [
    "a failed test",
    base([spec("C1: a"), { title: "C2: b", tests: [{ results: [{ status: "failed", attachments: [{ name: "video", path: "/v" }, { name: "trace", path: "/t" }] }] }] }]),
    "not passed",
    ["C2"],
  ],
  ["no video", base([spec("C1: a", {}, ["trace"]), spec("C2: b")]), "no video or trace", ["C1"]],
  ["no trace", base([spec("C1: a", {}, ["video"]), spec("C2: b")]), "no video or trace", ["C1"]],
  ["a video path that does not exist", base(good, { fileExists: (p) => !p.endsWith("C2: b/video") }), "no video or trace", ["C2"]],
  ["the commit changed", base(good, { head: "def" }), "commit changed since the run started", ["C1", "C2"]],
  ["dirty source", base(good, { dirty: true }), "source has uncommitted changes", ["C1", "C2"]],
  ["a test file changed", base(good, { testHashNow: "x" }), "a test file changed after the run started", ["C1", "C2"]],
] as const) {
  test(`fails on ${name}`, () => {
    const g = runGate(input);
    assert.equal(g.pass, false);
    const bad = g.rows.filter((r) => r.status === "FAIL");
    assert.deepEqual(bad.map((r) => r.id), failed);
    for (const r of bad) assert.ok(r.reasons.includes(reason), `${r.id}: ${r.reasons}`);
  });
}

test("a task with no claims never passes", () => {
  assert.equal(runGate(base(good, { claims: [] })).pass, false);
});
