#!/usr/bin/env bash
# Check 1: Playwright agents from the command line, with no files in the target repo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

WORK="$(cd "${WORK:-$(mktemp -d)}" && pwd -P)"
REPO="$WORK/games"
TASK="$WORK/task"
PORT="${PROOF_PORT:-5299}"
echo "work dir: $WORK"

step() { echo; echo "== step $1: $2"; }
fail() { echo; echo "FAIL (step $1): $2"; exit 1; }

scratch_games "$REPO"
assert_clean "$REPO"

step 1 "init-agents in a temp folder"
mkdir -p "$WORK/init"
(cd "$WORK/init" && npx -y "playwright@$PW_VERSION" init-agents --loop=claude >/dev/null) || fail 1 "init-agents failed"
ls "$WORK/init/.claude/agents"

step 2 "agent files -> --agents JSON"
node "$HERE/agents-to-json.mjs" "$WORK/init/.claude/agents" > "$WORK/agents.json" || fail 2 "agent conversion failed"
node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1]))))' "$WORK/agents.json"

step 3 "task folder with its own @playwright/test, proof config, MCP config"
mkdir -p "$TASK/proof-tests"
(cd "$TASK" && npm init -y >/dev/null && npm i -s "@playwright/test@$PW_VERSION") || fail 3 "npm install failed"
cp "$REPO/proof-tests/claims.md" "$TASK/claims.md"
cp "$WORK/init/seed.spec.ts" "$TASK/proof-tests/seed.spec.ts"
cat > "$TASK/playwright.config.ts" <<EOF
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "proof-tests",
  outputDir: "proof/results",
  reporter: [["list"], ["json", { outputFile: "proof/report.json" }]],
  use: { baseURL: "http://localhost:$PORT", video: "on", trace: "on" },
  webServer: {
    command: "npx vite --port $PORT --strictPort",
    cwd: "$REPO",
    port: $PORT,
    reuseExistingServer: true,
  },
});
EOF
cat > "$WORK/mcp.json" <<EOF
{ "mcpServers": { "playwright-test": {
  "command": "$TASK/node_modules/.bin/playwright",
  "args": ["run-test-mcp-server", "--headless", "-c", "$TASK/playwright.config.ts"]
} } }
EOF

step 4 "start Vite for the agent session"
(cd "$REPO" && npx vite --port "$PORT" --strictPort >"$WORK/vite.log" 2>&1) &
VITE_PID=$!
trap 'pkill -f "vite --port $PORT" || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/games/tic-tac-toe/" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$PORT/games/tic-tac-toe/" >/dev/null || fail 4 "vite did not start"

step 5 "test-writer session: claude -p with cwd = task folder, no --add-dir"
PROMPT="Use the playwright-test-generator agent to write one test for claim C1 in claims.md. The page is /games/tic-tac-toe/ at http://localhost:$PORT. Use the seed file proof-tests/seed.spec.ts. Save the test as proof-tests/c1.spec.ts."
START=$(date +%s)
(cd "$TASK" && echo "$PROMPT" | claude -p \
  --agents "$WORK/agents.json" \
  --mcp-config "$WORK/mcp.json" --strict-mcp-config \
  --allowedTools "Task" "Agent" "Read" "Glob" "Grep" "LS" "mcp__playwright-test__*" \
  --max-budget-usd 1.5 \
  --output-format stream-json --verbose \
  > "$WORK/session.jsonl" 2>"$WORK/session.err") || echo "claude exited non-zero: $?"
echo "session took $(( $(date +%s) - START ))s"
tail -1 "$WORK/session.jsonl" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log("result:",r.subtype,"cost:",r.total_cost_usd,"turns:",r.num_turns)' || true
grep -o '"name":"[A-Za-z_]*playwright[^"]*"\|"subagent_type":"[^"]*"' "$WORK/session.jsonl" | sort | uniq -c || true
pkill -f "vite --port $PORT" || true

SPECS=$(find "$TASK/proof-tests" -name '*.spec.ts' ! -name seed.spec.ts)
[ -n "$SPECS" ] || fail 5 "no spec in task folder; see $WORK/session.jsonl"
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const ids = new Set();
let ok = 0, bad = 0;
for (const r of rows) for (const c of r.message?.content ?? []) {
  if (c.type === "tool_use" && c.name === "mcp__playwright-test__generator_write_test") ids.add(c.id);
  if (c.type === "tool_result" && ids.has(c.tool_use_id)) (c.is_error || JSON.stringify(c.content).includes("Error") ? bad++ : ok++);
}
console.log(`generator_write_test: ${ok} ok, ${bad} failed`);
process.exit(ok ? 0 : 1);
' "$WORK/session.jsonl" || fail 5 "the generator agent did not write the spec; see $WORK/session.jsonl"
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const task = require("fs").realpathSync(process.argv[2]);
const outside = [];
for (const r of rows) for (const c of r.message?.content ?? []) {
  if (c.type !== "tool_use") continue;
  const p = c.input?.file_path ?? c.input?.path;
  if (p && ![task, process.argv[2]].some((t) => require("path").resolve(task, p).startsWith(t))) outside.push(`${c.name} ${p}`);
}
console.log(`file tool calls outside the task folder: ${outside.length}`);
outside.forEach((x) => console.log("  " + x));
process.exit(outside.length ? 1 : 0);
' "$WORK/session.jsonl" "$TASK" || fail 5 "the test writer read files outside the task folder"
echo "specs: $SPECS"

step 6 "run the test with the task folder's @playwright/test"
(cd "$TASK" && npx playwright test --config playwright.config.ts $SPECS) || fail 6 "test run failed"

REPORT="$TASK/proof/report.json"
[ -f "$REPORT" ] || fail 6 "no report.json"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
const att = [];
const walk = (s) => { (s.suites||[]).forEach(walk); (s.specs||[]).forEach(sp => sp.tests.forEach(t => t.results.forEach(x => att.push(...x.attachments)))); };
r.suites.forEach(walk);
for (const a of att) console.log(a.name, a.path);
const names = att.map(a => a.name);
if (!names.includes("video") || !names.includes("trace")) { console.log("report lacks video or trace"); process.exit(1); }
' "$REPORT" || fail 6 "report.json does not list video and trace"
find "$TASK/proof" -name '*.webm' | head -3

echo
assert_clean "$REPO" || fail 6 "games repo changed"
echo
echo "PASS: spec and video in task folder, report lists video and trace, games repo clean"
