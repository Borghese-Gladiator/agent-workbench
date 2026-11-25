import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awb, git, makeWork, startAwb, stubCommand } from "./harness.ts";

const work = makeWork();
const repo = join(work.dir, "repo");
const home = join(work.dir, "home");
const notices = join(work.dir, "notices.txt");

const CLAUDE = `
process.stdin.resume();
await new Promise((r) => process.stdin.on("end", r));
console.log(JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } } }));
await new Promise((r) => setTimeout(r, 120_000));
`;

const NOTIFY = `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(notices)}, process.argv[2] + " | " + process.argv[3] + "\\n");
`;

const RUN_MD = `## start
\`\`\`sh
node -e "require('http').createServer((q, r) => r.end('ok')).listen({port})"
\`\`\`
url: http://localhost:{port}
ready: /
`;

const env = {
  ...process.env,
  AWB_HOME: home,
  AWB_SYNC_MS: "3600000",
  AWB_TASK_TIMEOUT_MIN: "1",
  AWB_NOTIFY_CMD: stubCommand(join(work.dir, "bin"), "notify", NOTIFY),
  AWB_CLAUDE: stubCommand(join(work.dir, "bin"), "claude", CLAUDE),
};

const STACK = {
  tasks: [
    { title: "Slow task", context: "c", description: "d", claims: [{ id: "C1", text: "The page / shows a heading." }] },
    { title: "Never starts", context: "c", description: "d", claims: [{ id: "C1", text: "The page / shows a list." }] },
  ],
};

let t1 = "";
let t2 = "";
let follow = "";
let seconds = 0;
let runCode = 0;

const logs = async (...args: string[]) => (await awb(["logs", ...args], { cwd: repo, env })).stdout;

before(async () => {
  mkdirSync(join(repo, ".awb"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".awb", "run.md"), RUN_MD);
  await git(repo, "add", ".awb/run.md");
  await git(repo, "commit", "-q", "-m", "awb: start recipe");
  await git(repo, "remote", "add", "origin", repo);

  const set = await awb(["stack", "set", "--json"], { cwd: repo, env, input: JSON.stringify(STACK) });
  assert.equal(set.code, 0, set.stderr);
  const stack = JSON.parse(set.stdout).stack;
  t1 = stack.tasks[0].id.slice(0, 8);
  t2 = stack.tasks[1].id.slice(0, 8);

  const tail = startAwb(["logs", "--follow", "--task", t1], { cwd: repo, env });
  const began = Date.now();
  runCode = (await awb(["run", "--wait"], { cwd: repo, env })).code;
  seconds = (Date.now() - began) / 1000;
  await new Promise((r) => setTimeout(r, 2000));
  tail.child.kill();
  follow = tail.out();
});

after(async () => {
  await awb(["daemon", "stop"], { env });
  work.remove();
});

test("a run that passes the 1 min limit stops, and takes less than 90 s", () => {
  assert.notEqual(runCode, 0, "awb run --wait exited 0 for a stopped run");
  assert.ok(seconds < 90, `the run took ${seconds} s: the timeout did not stop the session`);
});

test("awb logs --task shows the session, the timeout, the failure and the run end", async () => {
  const text = await logs("--task", t1);
  assert.match(text, new RegExp(`INFO  runner\\.session\\.start task=${t1}`));
  assert.match(text, new RegExp(`WARN  runner\\.session\\.ended task=${t1}.*how=timeout after 1 min`));
  assert.match(text, new RegExp(`ERROR runner\\.task\\.failed task=${t1}.*session: timeout after 1 min`));
  assert.match(text, /runner\.run\.end.*state=stopped/);
  assert.doesNotMatch(await logs("--task", t2), /session\.start/);
});

test("--level error shows only error lines, and a stopped run is not a CLI error", async () => {
  const lines = (await logs("--level", "error", "--since", "1h")).split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "no error line");
  assert.ok(lines.every((l) => l.includes(" ERROR ")), "a line is not an error");
  assert.ok(!lines.some((l) => l.includes("cli.error command=run")), "a stopped run is logged as a CLI error");
});

test("--follow printed task.failed while the run went on", () => {
  assert.match(follow, /runner\.task\.failed/);
});

test("a failed CLI command writes cli.error, and a secret does not reach the file", async () => {
  const secret = `sk-ant-${"a".repeat(30)}`;
  const retry = await awb(["retry", secret], { cwd: repo, env });
  assert.notEqual(retry.code, 0, "awb retry of a bad id exited 0");
  assert.match(await logs("--source", "cli"), /ERROR cli\.error.*command=retry/);
  const files = readdirSync(join(home, "logs")).filter((f) => /^awb\..*\.jsonl$/.test(f));
  const all = files.map((f) => readFileSync(join(home, "logs", f), "utf8")).join("");
  assert.ok(!all.includes(secret), "the secret is in the log file");
  assert.match(all, /Anthropic key removed/);
});

test("the stop notice and the daemon start line exist", async () => {
  assert.match(readFileSync(notices, "utf8"), /stack stopped \| Slow task: .*timeout after 1 min/);
  assert.match(await logs("--source", "daemon"), /daemon\.start/);
});

test("every log line is valid JSON with ts, level, source and event", () => {
  const files = readdirSync(join(home, "logs")).filter((f) => /^awb\..*\.jsonl$/.test(f));
  const lines = files.flatMap((f) => readFileSync(join(home, "logs", f), "utf8").trim().split("\n"));
  assert.ok(lines.length > 0);
  for (const l of lines) {
    const j = JSON.parse(l);
    for (const k of ["ts", "level", "source", "event"]) assert.ok(j[k], `missing ${k}: ${l}`);
  }
});
