import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awb, git, makeWork, stubCommand } from "./harness.ts";

const work = makeWork();
const repo = join(work.dir, "team", "lib");
const home = join(work.dir, "home");

const WRITER = `
import { writeFileSync } from "node:fs";
process.stdin.resume();
await new Promise((r) => process.stdin.on("end", r));
const spec = (id, a, b) => \`import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../add.mjs";
test("\${id}: add(\${a}, \${b}) is 5", () => assert.equal(add(\${a}, \${b}), 5));
\`;
writeFileSync(".awb-proof/c1.test.mjs", spec("C1", 2, 3));
writeFileSync(".awb-proof/c2.test.mjs", spec("C2", 2, 2));
console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.12 }));
`;

const env = () => ({
  ...process.env,
  AWB_HOME: home,
  AWB_SYNC_MS: "3600000",
  AWB_NOTIFY: "0",
  AWB_WRITER_CLAUDE: stubCommand(join(work.dir, "bin"), "writer", WRITER),
});

before(async () => {
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "lib\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "checkout", "-q", "-b", "awb/add");
  writeFileSync(join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
  await git(repo, "add", "add.mjs");
  await git(repo, "commit", "-q", "-m", "add");
  mkdirSync(join(home, "repos"), { recursive: true });
  writeFileSync(join(home, "repos", "lib.run.md"), "## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n");
});

after(async () => {
  await awb(["daemon", "stop"], { env: env() });
  work.remove();
});

test("prove passes C1, fails C2, and leaves no awb file in the repo", async () => {
  const stack = { tasks: [{ title: "add", context: "c", description: "d", claims: [{ id: "C1", text: "add(2, 3) is 5", proof: "test" }, { id: "C2", text: "add(2, 2) is 5", proof: "test" }] }] };
  const set = await awb(["stack", "set"], { cwd: repo, env: env(), input: JSON.stringify(stack) });
  assert.equal(set.code, 0, set.stderr);

  const prove = await awb(["prove"], { cwd: repo, env: env() });
  assert.notEqual(prove.code, 0, "prove passed with a failing claim");
  assert.match(prove.stdout, /^C1 +PASS/m);
  assert.match(prove.stdout, /^C2 +FAIL.*not passed/m);
  assert.match(prove.stdout, /test writer: success, 2 turns, 0\.12 USD, limit 30 min/);

  assert.equal(await git(repo, "status", "--porcelain"), "");
});
