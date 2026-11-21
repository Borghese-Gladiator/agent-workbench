import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFromDisk, prove, seedCache, seedCopy, writerLimit } from "../src/prove.ts";
import type { Task } from "../src/stacks.ts";

const fakeClaude = (file: string, body: string) => {
  writeFileSync(`${file}.mjs`, `import { readFileSync, copyFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";\nreadFileSync(0);\n${body}\n`);
  if (process.platform === "win32") writeFileSync(file, `@"${process.execPath}" "${file}.mjs" %*\r\n`);
  else {
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${file}.mjs" "$@"\n`);
    chmodSync(file, 0o755);
  }
};

const claudePath = (root: string) => join(root, process.platform === "win32" ? "claude.cmd" : "claude");

const RESULT = (cost: number, turns: number) => `console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: ${turns}, total_cost_usd: ${cost} }));`;

delete process.env.NODE_TEST_CONTEXT;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const RUN_MD = "## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n";

const PROOF = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../add.mjs";
test("C1: add sums two numbers", () => assert.equal(add(2, 3), 5));
`;

const commit = (repo: string, addBody: string) => {
  writeFileSync(join(repo, "add.mjs"), `export const add = (a, b) => ${addBody};\n`);
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qm", addBody);
};

function setup(addBody: string, writerExtra = "", baseBody?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-prove-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  if (baseBody) {
    commit(repo, baseBody);
    git(repo, "switch", "-q", "-c", "feat");
  }
  commit(repo, addBody);

  const claude = claudePath(root);
  writeFileSync(join(root, "proof.mjs"), PROOF);
  fakeClaude(claude, `copyFileSync(${JSON.stringify(join(root, "proof.mjs"))}, ".awb-proof/c1.test.mjs");\n${writerExtra}\n${RESULT(0, 1)}`);

  const task = {
    id: "t1",
    title: "Add",
    claims: [{ id: "C1", text: "add sums two numbers", proof: "test" }],
    folder: join(root, "task"),
    branch: baseBody ? "feat" : null,
    base: baseBody ? "main" : null,
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
  const { repo, task, deps } = setup("a - b", `writeFileSync("add.mjs", "export const add = (a, b) => a + b;\\n");`);
  await assert.rejects(prove(task, repo, RUN_MD, deps), /changed the source/);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.match(git(repo, "show", "HEAD:add.mjs"), /a - b/);
});

test("prove: a writer that times out still has the cost of its messages", async () => {
  const { repo, task, deps } = setup("a + b");
  const msg = JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
  fakeClaude(deps.claude, `console.log(${JSON.stringify(msg)});\nsetTimeout(() => {}, 5000);`);
  const r = await prove(task, repo, RUN_MD, { ...deps, writerTimeoutMin: 0.01 });
  assert.equal(r.writer?.end, "timeout after 0.01 min");
  assert.equal(r.writer?.usd?.toFixed(2), "4.00");
});

test("prove: the writer runs once more for a claim that still has no test", async () => {
  const { repo, task, deps } = setup("a + b");
  const count = join(task.folder, "..", "calls");
  fakeClaude(
    deps.claude,
    `appendFileSync(${JSON.stringify(count)}, "x\\n");\nif (readFileSync(${JSON.stringify(count)}, "utf8").split("\\n").filter(Boolean).length >= 2) copyFileSync(${JSON.stringify(join(task.folder, "..", "proof.mjs"))}, ".awb-proof/c1.test.mjs");\n${RESULT(0.5, 0)}`,
  );
  const r = await prove(task, repo, RUN_MD, deps);
  assert.equal(r.gate.pass, true);
  assert.equal(readFileSync(count, "utf8").split("\n").filter(Boolean).length, 2);
  assert.equal(r.writer?.end, "success, 0 turns; rerun: success, 0 turns");
  assert.equal(r.writer?.usd, 1);
});

test("prove: a writer that writes every test runs once", async () => {
  const { repo, task, deps } = setup("a + b", `appendFileSync("../calls", "x\\n");`);
  await prove(task, repo, RUN_MD, deps);
  assert.equal(readFileSync(join(repo, "..", "calls"), "utf8").split("\n").filter(Boolean).length, 1);
});

test("writerLimit: the writer gets the session time that is left, up to its own limit", () => {
  const now = 1_000_000;
  assert.equal(writerLimit(30, undefined, now), 30);
  assert.equal(writerLimit(30, now + 10 * 60_000, now), 10);
  assert.equal(writerLimit(30, now + 90 * 60_000, now), 30);
  assert.equal(writerLimit(30, now + 30_000, now), 0);
});

test("prove: with no time left in the session, the writer does not start", async () => {
  const { repo, task, deps } = setup("a + b", `writeFileSync("../started", "");`);
  const r = await prove(task, repo, RUN_MD, { ...deps, deadline: Date.now() + 30_000 });
  assert.equal(existsSync(join(repo, "..", "started")), false);
  assert.deepEqual(r.gate.rows[0].reasons, ["no test (test writer: no time left in the session)"]);
});

for (const [name, baseBody, headBody, reasons] of [
  ["a test that fails on the base commit and passes on head passes", "a - b", "a + b", []],
  ["a test that also passes on the base commit fails", "a + b", "b + a", ["passes on the base commit"]],
] as const) {
  test(`prove: ${name}`, async () => {
    const { repo, task, deps } = setup(headBody, "", baseBody);
    const r = await prove(task, repo, RUN_MD, deps);
    assert.deepEqual(r.gate.rows[0].reasons, reasons);
    assert.equal(git(repo, "branch", "--show-current").trim(), "feat");
    assert.ok(git(repo, "show", "HEAD:add.mjs").includes(headBody));
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
}

test("prove: a carried claim of the task below fails when the new code breaks it", async () => {
  const below = setup("a + b");
  const r1 = await prove(below.task, below.repo, RUN_MD, below.deps);
  assert.equal(r1.gate.pass, true);
  writeFileSync(join(below.repo, "add.mjs"), "export const add = (a, b) => a - b;\nexport const two = () => 2;\n");
  git(below.repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "commit", "-qam", "task 2");
  const task2 = { ...below.task, id: "t2", claims: [], folder: join(below.task.folder, "..", "task2") } as Task;
  const carried = [{ label: "T1", claims: below.task.claims, folder: below.task.folder }];
  const r2 = await prove(task2, below.repo, RUN_MD, below.deps, [], carried);
  assert.equal(r2.gate.pass, false);
  assert.deepEqual(r2.gate.rows.map((r) => [r.id, r.status]), [["T1/C1", "FAIL"]]);
  assert.deepEqual(gateFromDisk(task2.claims, task2.folder, below.repo).rows.map((r) => r.id), ["T1/C1"]);
});

test("seed: the cache is built once, a key file change builds it again, and each proof gets a copy", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-seed-test-")));
  const repo = join(root, "repo");
  const dir = join(root, "home", "repos", "repo.seed");
  mkdirSync(repo);
  writeFileSync(join(repo, "schema.sql"), "v1");
  writeFileSync(join(repo, "seed.sh"), `echo run >> ${join(root, "runs")}\necho data > "$1/data.txt"\n`);
  const seed = { cmd: "sh seed.sh {seed}", key: ["schema.sql"], about: "" };
  const runs = () => readFileSync(join(root, "runs"), "utf8").split("\n").filter(Boolean).length;

  const a = await seedCache(seed, repo, dir, root, () => {});
  const b = await seedCache(seed, repo, dir, root, () => {});
  assert.equal(a, b);
  assert.equal(runs(), 1);
  assert.deepEqual(readdirSync(dir), [a.split("/").pop()]);

  const copy = seedCopy(a);
  assert.notEqual(copy, a);
  writeFileSync(join(copy, "data.txt"), "changed");
  assert.equal(readFileSync(join(a, "data.txt"), "utf8"), "data\n");

  writeFileSync(join(repo, "schema.sql"), "v2");
  const c = await seedCache(seed, repo, dir, root, () => {});
  assert.notEqual(c, a);
  assert.equal(runs(), 2);
});

test("seed: a failed seed command writes seed.log, throws, and leaves no cache", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awb-seed-test-")));
  const dir = join(root, "repo.seed");
  await assert.rejects(seedCache({ cmd: "echo boom {seed}; exit 3", key: [], about: "" }, root, dir, root, () => {}), /exit 3/);
  assert.match(readFileSync(join(root, "seed.log"), "utf8"), /boom/);
  assert.deepEqual(readdirSync(dir), []);
});
