import { test } from "node:test";
import assert from "node:assert/strict";
import { runGate, junitReport, type GateInput, type ReportSpec } from "../src/gate.ts";

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

const junit = `<?xml version="1.0"?><testsuites><testsuite name="x">
<testcase name="C1: replan keeps &quot;Dentist&quot;" time="0.1"/>
<testcase name="C2: no conflict" time="0.1"><failure message="boom">x</failure></testcase>
<testcase name="C3: skip me"><skipped/></testcase>
</testsuite></testsuites>`;

test("JUnit: a test claim passes with no video, and a failure or skip fails it", () => {
  const claims = [1, 2, 3].map((n) => ({ id: `C${n}`, text: "t", proof: "test" as const }));
  const g = runGate(base([], { claims, report: junitReport(junit) }));
  assert.deepEqual(g.rows.map((r) => [r.id, r.status, r.reasons]), [
    ["C1", "PASS", []],
    ["C2", "FAIL", ["not passed"]],
    ["C3", "FAIL", ["skipped"]],
  ]);
});

test("JUnit: a browser claim still needs a video", () => {
  const g = runGate(base([], { claims: [{ id: "C1", text: "t" }], report: junitReport(junit) }));
  assert.deepEqual(g.rows[0].reasons, ["no video or trace"]);
});

const pytest = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" tests="3">
<testcase classname=".awb-proof.c1_test" name="test_touching_events_do_not_overlap" time="0.01" />
<testcase classname=".awb-proof.c2_test" name="test_pick_slot" time="0.01"><failure message="assert 5 == 6">E assert</failure></testcase>
<testcase classname=".awb-proof.c3_test" name="test_later"><skipped type="pytest.skip" message="x" /></testcase>
</testsuite></testsuites>`;

const vitest = `<testsuites name="vitest tests"><testsuite name=".awb-proof/c2.test.js" tests="2">
<testcase classname=".awb-proof/c1.test.js" name="C1: add sums" time="0.1"></testcase>
<testcase classname=".awb-proof/c2.test.js" name="group &gt; inner" time="0.1"><failure message="x">x</failure></testcase>
</testsuite></testsuites>`;

const testClaims = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, text: "t", proof: "test" as const }));

for (const [name, xml, n, want] of [
  ["pytest maps a claim from the file name", pytest, 3, [["C1", "PASS"], ["C2", "FAIL"], ["C3", "FAIL"]]],
  ["vitest maps a claim from the test name, or else the file name", vitest, 2, [["C1", "PASS"], ["C2", "FAIL"]]],
] as const) {
  test(`JUnit: ${name}`, () => {
    const g = runGate(base([], { claims: testClaims(n), report: junitReport(xml) }));
    assert.deepEqual(g.rows.map((r) => [r.id, r.status]), want);
  });
}

test("junitReport reads a test name with an unescaped > in it, as node --test writes it", () => {
  const xml = `<testsuites>
\t<testcase name="C1: GET /api/x?id=&lt;id> answers 200" file="/w/.awb-proof/c1.test.ts"/>
\t<testcase name="C2: a > b" file="/w/.awb-proof/c2.test.ts"><failure message="no"/></testcase>
</testsuites>`;
  const specs = junitReport(xml).suites[0].specs!;
  assert.deepEqual(specs.map((s) => [s.title, s.tests[0].results[0].status]), [
    ["C1: GET /api/x?id=<id> answers 200", "passed"],
    ["C2: a > b", "failed"],
  ]);
});
