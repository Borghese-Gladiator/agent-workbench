import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prBody, findSecrets, syncStatus, readTemplate } from "../src/ship.ts";
import { gateFromDisk, testHash, removeTests } from "../src/prove.ts";
import type { GateResult } from "../src/gate.ts";

const claims = [
  { id: "C1", text: "Shows | X wins" },
  { id: "C2", text: "Counts draws" },
];
const gate: GateResult = {
  pass: true,
  head: "3f9c2a1abcdef",
  reasons: [],
  rows: claims.map((c) => ({ id: c.id, tests: 1, status: "PASS", reasons: [], videos: [`/v/${c.id}.webm`], traces: [`/t/${c.id}.zip`] })),
};
const body = (videoUrls: Record<string, string[]>) =>
  prBody({
    title: "Add a scoreboard",
    context: "Players cannot see who leads over many games.",
    description: "Adds a session scoreboard to the page.",
    commits: ["abc123 feat: scoreboard"],
    claims,
    gate,
    videoUrls,
    start: "npx vite --port {port}",
    tests: "`playwright test`",
    folder: "/h/tasks/t1",
    specs: [{ name: "c1.spec.ts", text: "test('C1: x', () => {});\n" }],
  });

test("PR body: a row and a video link for each claim, the run facts and the specs", () => {
  const b = body({ C1: ["https://gh/c1.webm"], C2: ["https://gh/c2.webm"] });
  assert.match(b, /\| C1 \| Shows \\\| X wins \| PASS \| \[video\]\(https:\/\/gh\/c1\.webm\) \|/);
  assert.match(b, /\| C2 \| Counts draws \| PASS \| \[video\]\(https:\/\/gh\/c2\.webm\) \|/);
  assert.match(b, /Commit: `3f9c2a1abcdef`/);
  assert.match(b, /Start: `npx vite --port \{port\}`/);
  assert.match(b, /<summary><h4>Test Code<\/h4><\/summary>\n\n1 proof test files[\s\S]*#### c1\.spec\.ts[\s\S]*C1: x[\s\S]*<\/details>/);
  assert.match(b, /Generated with \[Claude Code\]/);
});

test("PR body: Context and Description come first, then the Changes list", () => {
  const b = body({});
  assert.match(b, /^## Context\n\nPlayers cannot see who leads over many games\.\n\n## Description\n\nAdds a session scoreboard to the page\.\n\n#### Changes\n\n- abc123 feat: scoreboard\n/);
});

test("PR body: no commits, no Changes heading", () => {
  const b = prBody({ title: "t", context: "c", description: "d", commits: [], claims, gate, videoUrls: {}, start: "s", tests: "x", folder: "/f", specs: [] });
  assert.doesNotMatch(b, /#### Changes/);
});

test("PR body: the Features summary shows the result and the commit", () => {
  const b = body({});
  assert.match(b, /<summary><h4>Features: 2\/2 claims PASS at 3f9c2a1<\/h4><\/summary>\n\n\| Claim \| Sentence \| Result \| Video \|/);
});

test("PR body: the Test Plan lists the videos and the test command", () => {
  const b = body({ C1: ["https://gh/c1.webm"], C2: ["https://gh/c2.webm"] });
  assert.match(b, /## Test Plan\n\n- C1: \[video\]\(https:\/\/gh\/c1\.webm\)\n- C2: \[video\]\(https:\/\/gh\/c2\.webm\)\n\nTests: `playwright test`\n/);
});

test("PR body: the run facts are in a closed details block", () => {
  assert.match(body({}), /<details>\n<summary><h4>How it was run<\/h4><\/summary>\n\n- Start:[\s\S]*cookies\.\n\n<\/details>/);
});

test("PR body: no Not proven section, and no Not tested line when every claim has a video", () => {
  const b = body({ C1: ["https://gh/c1.webm"], C2: ["https://gh/c2.webm"] });
  assert.doesNotMatch(b, /Not proven/);
  assert.doesNotMatch(b, /Not tested/);
});

test("PR body: Test Code Output shows only when the author gives output", () => {
  assert.doesNotMatch(body({}), /Test Code Output/);
  const b = prBody({ title: "t", context: "c", description: "d", output: "ok 12 rows on prod\n", commits: [], claims, gate, videoUrls: {}, start: "s", tests: "x", folder: "/f", specs: [] });
  assert.match(b, /<summary><h4>Test Code Output<\/h4><\/summary>\n\n````\nok 12 rows on prod\n````/);
});

const withStack = (stack: { title: string; pr: number | null; current: boolean }[], template: string | null = null) =>
  prBody({ title: "t", context: "c", description: "d", commits: [], claims, gate, videoUrls: {}, start: "s", tests: "x", folder: "/f", specs: [], stack, template });

test("PR body: a stack of more than one task shows the merge order, open", () => {
  const b = withStack([
    { title: "Base | layout", pr: 11, current: false },
    { title: "Carousel", pr: 12, current: true },
    { title: "Completed state", pr: null, current: false },
  ]);
  assert.match(b, /<details open><summary><b>PR Merge Order<\/b><\/summary>/);
  assert.match(b, /\| 1 \| #11 \| Base \\\| layout \|\n\| 2 \| #12 \(this PR\) \| Carousel \|\n\| 3 \| not shipped \| Completed state \|/);
  assert.ok(b.indexOf("PR Merge Order") < b.indexOf("Features:"));
});

test("PR body: one task, no merge order; no template, no template block", () => {
  const b = withStack([{ title: "Only", pr: 5, current: true }]);
  assert.doesNotMatch(b, /PR Merge Order/);
  assert.doesNotMatch(b, /PR template/);
});

test("PR body: the repo template goes in a closed details block before the footer", () => {
  const b = withStack([], "## Checklist\n\n- [ ] Tests");
  assert.match(b, /<details><summary><b>PR template<\/b> \(awb does not fill it\)<\/summary>\n\n## Checklist\n\n- \[ \] Tests\n\n<\/details>\n\n🤖 Generated/);
});

test("readTemplate finds the GitHub template, and gives null when none or empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "awb-tpl-"));
  assert.equal(readTemplate(dir), null);
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "pull_request_template.md"), "  \n");
  assert.equal(readTemplate(dir), null);
  writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Checklist\n");
  assert.equal(readTemplate(dir), "## Checklist");
});

test("PR body: a claim with no uploaded video is listed in the Not tested line", () => {
  const b = body({ C1: ["https://gh/c1.webm"] });
  assert.match(b, /\| C2 \| Counts draws \| PASS \| none \|/);
  assert.match(b, /Not tested: C2 has no video\./);
});

for (const [kind, text] of [
  ["GitHub token", `const t = "ghp_${"a".repeat(36)}";`],
  ["AWS access key", "key = AKIAABCDEFGHIJKLMNOP"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["Anthropic key", `sk-ant-api03-${"x".repeat(30)}`],
]) {
  test(`secret scan finds a ${kind}`, () => {
    assert.deepEqual(findSecrets([{ name: "c1.spec.ts", text }]), [`${kind} in c1.spec.ts`]);
  });
}

test("secret scan passes normal test code", () => {
  const text = `await page.getByLabel("Password").fill("Test1234!");\nawait expect(page.getByText("X wins")).toHaveText("1");`;
  assert.deepEqual(findSecrets([{ name: "c1.spec.ts", text }]), []);
});

for (const [state, want] of [["MERGED", "merged"], ["CLOSED", "closed"], ["OPEN", null]] as const) {
  test(`PR sync: ${state} gives ${want}`, () => assert.equal(syncStatus(state), want));
}

function proofOnDisk() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-ship-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", ...a], { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  writeFileSync(join(repo, "a.txt"), "a");
  g("add", ".");
  g("commit", "-qm", "a");
  const folder = join(root, "task");
  mkdirSync(join(folder, "proof-tests"), { recursive: true });
  mkdirSync(join(folder, "proof"));
  writeFileSync(join(folder, "proof-tests", "c1.spec.ts"), "test('C1: a', () => {});");
  const video = join(folder, "proof", "v.webm");
  const trace = join(folder, "proof", "t.zip");
  writeFileSync(video, "");
  writeFileSync(trace, "");
  const report = {
    suites: [{ specs: [{ title: "C1: a", tests: [{ status: "expected", results: [{ status: "passed", attachments: [{ name: "video", path: video }, { name: "trace", path: trace }] }] }] }] }],
  };
  writeFileSync(join(folder, "proof", "report.json"), JSON.stringify(report));
  writeFileSync(join(folder, "proof", "sha.txt"), g("rev-parse", "HEAD") + "\n");
  writeFileSync(join(folder, "proof", "test-hash.txt"), testHash(join(folder, "proof-tests")) + "\n");
  return { repo, folder };
}

test("gate from disk passes on the saved proof", () => {
  const { repo, folder } = proofOnDisk();
  const g = gateFromDisk([{ id: "C1", text: "a" }], folder, repo);
  assert.equal(g.pass, true, JSON.stringify(g.rows));
});

test("gate from disk fails when a spec changed after the run", () => {
  const { repo, folder } = proofOnDisk();
  writeFileSync(join(folder, "proof-tests", "c1.spec.ts"), "test('C1: a', () => { /* edited */ });");
  const g = gateFromDisk([{ id: "C1", text: "a" }], folder, repo);
  assert.equal(g.pass, false);
  assert.deepEqual(g.reasons, ["a test file changed after the run started"]);
});

test("gate from disk fails when the source is dirty", () => {
  const { repo, folder } = proofOnDisk();
  writeFileSync(join(repo, "a.txt"), "changed");
  assert.deepEqual(gateFromDisk([{ id: "C1", text: "a" }], folder, repo).reasons, ["source has uncommitted changes"]);
});

test("removeTests deletes only the specs that name a listed claim, and never the seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "awb-rewrite-"));
  writeFileSync(join(dir, "c1.spec.ts"), 'test("C1: x wins", () => {});');
  writeFileSync(join(dir, "c12.spec.ts"), 'test("C12: other", () => {});');
  writeFileSync(join(dir, "c3.spec.ts"), 'test("C3: locked", () => {});');
  writeFileSync(join(dir, "seed.spec.ts"), 'test("seed C1", () => {});');
  assert.deepEqual(removeTests(["C1"], dir), ["c1.spec.ts"]);
  assert.deepEqual(readdirSync(dir).sort(), ["c12.spec.ts", "c3.spec.ts", "seed.spec.ts"]);
  assert.deepEqual(removeTests([], dir), []);
});

test("PR body: a test claim shows repo test, and no video is missing for it", () => {
  const b = prBody({
    title: "Engine", context: "c", description: "d",
    commits: [],
    claims: [{ id: "C1", text: "replans", proof: "test" }],
    gate: { ...gate, rows: [{ id: "C1", tests: 1, status: "PASS", reasons: [], videos: [], traces: [] }] },
    videoUrls: {},
    start: "none (repo tests only)",
    tests: "`npm test`",
    folder: "/h/tasks/t1",
    specs: [],
  });
  assert.match(b, /\| C1 \| replans \| PASS \| repo test \|/);
  assert.doesNotMatch(b, /Not tested/);
});

test("test files: the claim comes from the file name, in each language", async () => {
  const { testFileClaim, claimsWithoutTest, removeTests, testHash } = await import("../src/prove.ts");
  assert.deepEqual(
    ["c1.test.ts", "c2_test.py", "C3.test.mjs", "c12_pick_slot_test.py", "c1.spec.ts", "seed.spec.ts", "conftest.py", "c1.json"].map(testFileClaim),
    ["C1", "C2", "C3", "C12", null, null, null, null],
  );
  const dir = mkdtempSync(join(tmpdir(), "awb-files-"));
  writeFileSync(join(dir, "c1_test.py"), "def test_x():\n    assert True\n");
  const claims = [{ id: "C1", text: "a", proof: "test" as const }, { id: "C2", text: "b", proof: "test" as const }];
  assert.deepEqual(claimsWithoutTest(claims, dir).map((c) => c.id), ["C2"]);
  const before = testHash(dir);
  writeFileSync(join(dir, "c1_test.py"), "def test_x():\n    assert False\n");
  assert.notEqual(testHash(dir), before);
  assert.deepEqual(removeTests(["C1"], dir), ["c1_test.py"]);
});
