import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecipe, fill } from "../src/recipe.ts";

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
  const r = parseRecipe(vite);
  assert.equal(r.start, "npx vite --port {port} --strictPort");
  assert.equal(fill(r.url, 5301), "http://localhost:5301");
  assert.equal(r.ready, "/games/tic-tac-toe/");
});

test("an app that is already running has no start block", () => {
  const r = parseRecipe("## Start\nurl: http://www.local-klaviyo.com:8080\nready: /login\n");
  assert.equal(r.start, null);
  assert.equal(r.url, "http://www.local-klaviyo.com:8080");
});

test("ready defaults to /", () => {
  assert.equal(parseRecipe("## start\nurl: http://x\n").ready, "/");
});

for (const [name, text] of [
  ["no start section", "# Run\nurl: http://x\n"],
  ["no url", "## start\n```sh\nnpm start\n```\n"],
] as const) {
  test(`refuses ${name}`, () => assert.throws(() => parseRecipe(text)));
}
