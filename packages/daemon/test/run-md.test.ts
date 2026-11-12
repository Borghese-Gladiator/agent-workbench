import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSetup, parseRunMd, parseTest, fillTest, fill, findRunFile, readRunFile, runFilePath, envFilePath } from "../src/run-md.ts";

const vite = `# Run

## start
\`\`\`sh
npx vite --port {port} --strictPort
\`\`\`
url: http://localhost:{port}
ready: /games/tic-tac-toe/

## stop
Ctrl-C.
`;

test("parses the start command, url and ready path, and stops at the next section", () => {
  const r = parseRunMd(vite);
  assert.equal(r.start, "npx vite --port {port} --strictPort");
  assert.equal(fill(r.url, 5301), "http://localhost:5301");
  assert.equal(r.ready, "/games/tic-tac-toe/");
});

test("an app that is already running has no start block", () => {
  const r = parseRunMd("## Start\nurl: http://www.local-klaviyo.com:8080\nready: /login\n");
  assert.equal(r.start, null);
  assert.equal(r.url, "http://www.local-klaviyo.com:8080");
});

test("ready defaults to /", () => {
  assert.equal(parseRunMd("## start\nurl: http://x\n").ready, "/");
});

for (const [name, text] of [
  ["no start section", "# Run\nurl: http://x\n"],
  ["no url", "## start\n```sh\nnpm start\n```\n"],
] as const) {
  test(`refuses ${name}`, () => assert.throws(() => parseRunMd(text)));
}

test("the setup section gives its command, and no section gives null", () => {
  assert.equal(parseSetup("## setup\n```sh\nnpm ci\n```\n\n## start\nurl: http://x\n"), "npm ci");
  assert.equal(parseSetup("## start\nurl: http://x\n"), null);
});

test("parses the test command and fills the files and the report path", () => {
  const cmd = parseTest("## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n## start\nurl: http://x\n");
  assert.equal(fillTest(cmd, [".awb-proof/c1.test.ts", "it's.test.ts"], "/h/junit.xml"),
    "node --test --test-reporter=junit --test-reporter-destination='/h/junit.xml' '.awb-proof/c1.test.ts' 'it'\\''s.test.ts'");
});

for (const [name, text] of [
  ["no test section", "## start\nurl: http://x\n"],
  ["a test command with no {report}", "## test\n```sh\nnode --test {tests}\n```\n"],
]) {
  test(`parseTest refuses ${name}`, () => assert.throws(() => parseTest(text)));
}

test("the run file in the worktree wins, the file in AWB_HOME is the fallback, and no file names the AWB_HOME path", () => {
  const root = mkdtempSync(join(tmpdir(), "awb-run-md-"));
  const home = join(root, "home");
  const repo = join(root, "games");
  const worktree = join(root, "wt");
  mkdirSync(join(home, "repos"), { recursive: true });
  mkdirSync(join(worktree, ".awb"), { recursive: true });
  const shared = runFilePath(home, repo);
  assert.equal(shared, join(home, "repos", "games.run.md"));

  assert.equal(findRunFile(home, repo, worktree), null);
  assert.throws(() => readRunFile(home, repo, worktree), new RegExp(shared));

  writeFileSync(shared, "## start\nurl: http://shared\n");
  assert.equal(readRunFile(home, repo, worktree), "## start\nurl: http://shared\n");

  writeFileSync(join(worktree, ".awb", "run.md"), "## start\nurl: http://own\n");
  assert.equal(readRunFile(home, repo, worktree), "## start\nurl: http://own\n");
});

test("the env file of a repo is next to its run file in AWB_HOME", () => {
  assert.equal(envFilePath("/h", "/src/games"), join("/h", "repos", "games.env"));
});
