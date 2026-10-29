#!/usr/bin/env bash
# Fender spike: can the phase 0 proof design prove claims on fender, where the page needs
# the app stack, a seeded login and seeded data? Measures setup and run cost.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PHASE0="$HERE/../phase0"
FENDER="${FENDER:-$HOME/Klaviyo/Repos/fender}"
SEED="$HOME/GitHub/klaviyo-local-seed/bin/seed"
PW_VERSION="${PW_VERSION:-1.61.1}"
BASE="http://www.local-klaviyo.com:8080"
WORK="$(cd "${WORK:-$(mktemp -d)}" && pwd -P)"
TASK="$WORK/task"
EMAIL="awb-spike-$(date +%s)@test.com"
PASSWORD='Test1234!'
COMPANY="AWB Spike Co"
echo "work dir: $WORK"

step() { echo; echo "== $1"; date +%s > "$WORK/t-$2"; }
fail() { echo; echo "FAIL ($1): $2"; exit 1; }
FENDER_BEFORE="$(git -C "$FENDER" status --porcelain)"

step "1. stack health" doctor
curl -sf -o /dev/null -m 10 "$BASE/login" || fail 1 "$BASE/login does not answer"
"$SEED" doctor > "$WORK/doctor.txt" 2>&1 || { grep -v '"logger"' "$WORK/doctor.txt" | tail -20; fail 1 "seed doctor failed"; }
grep -v '"logger"' "$WORK/doctor.txt" | tail -8

step "2. seed a loginable account with a dashboard" seed
"$SEED" scenario full --email "$EMAIL" --password "$PASSWORD" --company-name "$COMPANY" > "$WORK/seed.txt" 2>&1 \
  || { grep -v '"logger"' "$WORK/seed.txt" | tail -20; fail 2 "seed scenario failed"; }
grep -v '"logger"' "$WORK/seed.txt" | tail -8
"$SEED" verify --email "$EMAIL" --password "$PASSWORD" > "$WORK/verify.txt" 2>&1 || fail 2 "seed verify failed"

step "3. task folder: claims, proof config, login setup" setup
mkdir -p "$TASK/proof-tests" "$WORK/init"
(cd "$WORK/init" && npx -y "playwright@$PW_VERSION" init-agents --loop=claude >/dev/null)
node "$PHASE0/agents-to-json.mjs" "$WORK/init/.claude/agents" > "$WORK/agents.json"
(cd "$TASK" && npm init -y >/dev/null && npm pkg set type=module && npm i -s "@playwright/test@$PW_VERSION")

cat > "$TASK/claims.md" <<EOF
# Claims: signed-in fender shell and the seeded dashboard

Site: $BASE. The browser is already signed in as $EMAIL in the company "$COMPANY".
The company has one custom dashboard named "Local Seed Dashboard".

- C1: After sign-in, the app shell shows the company name "$COMPANY".
- C2: The dashboards list shows a dashboard named "Local Seed Dashboard".
- C3: Opening "Local Seed Dashboard" shows its title "Local Seed Dashboard" on the dashboard page.
EOF

cat > "$TASK/global-setup.ts" <<EOF
import { chromium } from "@playwright/test";
export default async function () {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("$BASE/login");
  await page.getByLabel(/email/i).fill("$EMAIL");
  await page.getByLabel(/password/i).fill("$PASSWORD");
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.context().storageState({ path: "$TASK/auth.json" });
  await browser.close();
}
EOF

cat > "$TASK/playwright.config.ts" <<EOF
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "proof-tests",
  outputDir: "proof/results",
  timeout: 90_000,
  globalSetup: "./global-setup.ts",
  reporter: [["list"], ["json", { outputFile: "proof/report.json" }]],
  use: { baseURL: "$BASE", storageState: "$TASK/auth.json", video: "on", trace: "on" },
});
EOF

cat > "$TASK/proof-tests/seed.spec.ts" <<EOF
import { test } from "@playwright/test";
test("seed", async ({ page }) => {
  await page.goto("/dashboard");
});
EOF

cat > "$WORK/mcp.json" <<EOF
{ "mcpServers": { "playwright-test": {
  "command": "$TASK/node_modules/.bin/playwright",
  "args": ["run-test-mcp-server", "--headless", "-c", "$TASK/playwright.config.ts"]
} } }
EOF

echo "login check:"
(cd "$TASK" && node -e '
import("./global-setup.ts").then((m) => m.default()).then(() => console.log("signed in, auth.json saved")).catch((e) => { console.error(e.message); process.exit(1); });
') || fail 3 "the login setup failed"

step "4. test writer: claude -p in the task folder" writer
PROMPT="Use the playwright-test-generator agent once for each claim in claims.md (C1, C2, C3). The browser is already signed in. The site is $BASE. Fender component testids get a suffix in the DOM, so prefer role and text locators, or match a testid by prefix. Some routes are client-side only: if a direct URL gives a 404, load /dashboard first and then navigate in the app. Use the seed file proof-tests/seed.spec.ts. Save each test as proof-tests/c<N>.spec.ts. Put the claim id at the start of each test title."
(cd "$TASK" && echo "$PROMPT" | claude -p \
  --agents "$WORK/agents.json" \
  --mcp-config "$WORK/mcp.json" --strict-mcp-config \
  --allowedTools "Task" "Agent" "Read" "Glob" "Grep" "LS" "mcp__playwright-test__*" \
  --max-budget-usd 4 \
  --output-format stream-json --verbose \
  > "$WORK/session.jsonl" 2>"$WORK/session.err") || echo "claude exited non-zero: $?"
tail -1 "$WORK/session.jsonl" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log("result:",r.subtype,"| cost USD:",r.total_cost_usd,"| turns:",r.num_turns)' || true
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const ids = new Set(); let ok = 0, bad = 0;
for (const r of rows) for (const c of r.message?.content ?? []) {
  if (c.type === "tool_use" && c.name === "mcp__playwright-test__generator_write_test") ids.add(c.id);
  if (c.type === "tool_result" && ids.has(c.tool_use_id)) (c.is_error || JSON.stringify(c.content).includes("Error") ? bad++ : ok++);
}
console.log(`generator_write_test: ${ok} ok, ${bad} failed`);
' "$WORK/session.jsonl"
ls "$TASK/proof-tests"

step "5. proof run: every test, video and trace" run
(cd "$TASK" && npx playwright test) || echo "some tests failed"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1]));
const out = [];
const walk = (s) => { (s.suites||[]).forEach(walk); for (const sp of s.specs||[]) for (const t of sp.tests) {
  const x = t.results.at(-1); const a = x.attachments.map((y) => y.name);
  out.push({ title: sp.title, status: x.status, video: a.includes("video"), trace: a.includes("trace") }); } };
r.suites.forEach(walk);
for (const o of out) console.log(`${o.status.padEnd(8)} video=${o.video} trace=${o.trace}  ${o.title}`);
const claims = ["C1", "C2", "C3"].map((c) => [c, out.find((o) => o.title.startsWith(c))]);
const missing = claims.filter(([, o]) => !o).map(([c]) => c);
const failed = claims.filter(([, o]) => o && (o.status !== "passed" || !o.video || !o.trace)).map(([c]) => c);
console.log("claims with no test:", missing.join(",") || "none", "| failed:", failed.join(",") || "none");
process.exit(missing.length || failed.length ? 1 : 0);
' "$TASK/proof/report.json" && GATE=pass || GATE=fail
date +%s > "$WORK/t-end"

echo
echo "== 6. repo and timing"
[ "$(git -C "$FENDER" status --porcelain)" = "$FENDER_BEFORE" ] && echo "fender git status: unchanged" || { echo "fender git status CHANGED"; GATE=fail; }
T() { echo $(( $(cat "$WORK/t-$2") - $(cat "$WORK/t-$1") ))s; }
echo "doctor: $(T doctor seed) | seed: $(T seed setup) | setup+login: $(T setup writer) | test writer: $(T writer run) | proof run: $(T run end)"
echo "company: $COMPANY | user: $EMAIL"
echo
[ "$GATE" = pass ] && echo "PASS" || { echo "FAIL: see above"; exit 1; }
