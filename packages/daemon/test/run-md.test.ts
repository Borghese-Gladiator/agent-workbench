import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetup, parseRunMd, parseTest, fillTest, fill } from "../src/run-md.ts";

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
