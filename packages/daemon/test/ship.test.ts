import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prBody, findSecrets, syncStatus } from "../src/ship.ts";
import { gateFromDisk, testHash } from "../src/prove.ts";
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
    commits: ["abc123 feat: scoreboard"],
    claims,
    gate,
    videoUrls,
    start: "npx vite --port {port}",
    folder: "/h/tasks/t1",
    specs: [{ name: "c1.spec.ts", text: "test('C1: x', () => {});\n" }],
  });

test("PR body: a row and a video link for each claim, the run facts and the specs", () => {
  const b = body({ C1: ["https://gh/c1.webm"], C2: ["https://gh/c2.webm"] });
  assert.match(b, /\| C1 \| Shows \\\| X wins \| PASS \| \[video\]\(https:\/\/gh\/c1\.webm\) \|/);
  assert.match(b, /\| C2 \| Counts draws \| PASS \| \[video\]\(https:\/\/gh\/c2\.webm\) \|/);
  assert.match(b, /Commit: `3f9c2a1abcdef`/);
  assert.match(b, /Start: `npx vite --port \{port\}`/);
  assert.match(b, /<details><summary>1 proof spec files[\s\S]*#### c1\.spec\.ts[\s\S]*C1: x[\s\S]*<\/details>/);
  assert.match(b, /## Not proven\n\nNone\./);
  assert.match(b, /Generated with \[Claude Code\]/);
});

test("PR body: a claim with no uploaded video is listed under Not proven", () => {
  const b = body({ C1: ["https://gh/c1.webm"] });
  assert.match(b, /\| C2 \| Counts draws \| PASS \| none \|/);
  assert.match(b, /- C2: no video uploaded\./);
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
