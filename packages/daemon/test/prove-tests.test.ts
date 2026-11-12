import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prove } from "../src/prove.ts";
import type { Task } from "../src/stacks.ts";

delete process.env.NODE_TEST_CONTEXT;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const RUN_MD = "## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n";

const PROOF = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../add.mjs";
test("C1: add sums two numbers", () => assert.equal(add(2, 3), 5));
`;

function setup(addBody: string, writerExtra = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-prove-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "add.mjs"), `export const add = (a, b) => ${addBody};\n`);
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "init");

  const claude = join(root, "claude");
  writeFileSync(join(root, "proof.mjs"), PROOF);
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\ncp ${join(root, "proof.mjs")} .awb-proof/c1.test.mjs\n${writerExtra}\necho '{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0}'\n`);
  chmodSync(claude, 0o755);

  const task = {
    id: "t1",
    title: "Add",
    claims: [{ id: "C1", text: "add sums two numbers", proof: "test" }],
    folder: join(root, "task"),
  } as Task;
  return { repo, task, deps: { claude, log: () => {} } };
}

test("prove: a test claim passes on correct code, with no app and no browser", async () => {
  const { repo, task, deps } = setup("a + b");
  const r = await prove(task, repo, RUN_MD, deps);
  assert.equal(r.table.split("\n")[0].trim(), "C1    PASS  tests=1");
  assert.equal(r.gate.pass, true);
  assert.deepEqual(readdirSync(join(task.folder, "proof-tests")), ["c1.test.mjs"]);
  assert.equal(existsSync(join(repo, ".awb-proof")), false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("prove: a test claim fails on wrong code", async () => {
  const { repo, task, deps } = setup("a - b");
  const r = await prove(task, repo, RUN_MD, deps);
  assert.equal(r.gate.pass, false);
  assert.deepEqual(r.gate.rows[0].reasons, ["not passed"]);
});

test("prove: a writer that edits the source is refused, and the edit is undone", async () => {
  const { repo, task, deps } = setup("a - b", `echo 'export const add = (a, b) => a + b;' > add.mjs`);
  await assert.rejects(prove(task, repo, RUN_MD, deps), /changed the source/);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.match(git(repo, "show", "HEAD:add.mjs"), /a - b/);
});
