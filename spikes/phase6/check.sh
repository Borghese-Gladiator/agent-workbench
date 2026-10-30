#!/usr/bin/env bash
# Phase 6 manual check, local only (no GitHub). A stub task session fails task 1 at the gate.
# Then the real claude, started by awb, answers "What did you do today, and what failed?"
# from the daemon. No awb command is typed by hand for the answer.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../phase0/lib.sh"
AWB="$HERE/../../packages/cli/bin/awb"
MODEL="${MODEL:-haiku}"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT

REPO="$WORK/games"
scratch_games "$REPO"
git -C "$REPO" remote set-url origin "$REPO"
git -C "$REPO" checkout -q -b awb/phase6-base
mkdir -p "$REPO/.awb"
cat > "$REPO/.awb/run.md" <<EOF
## setup
\`\`\`sh
cp -cR "$REPO/node_modules" node_modules
\`\`\`

## start
\`\`\`sh
npx vite --port {port} --strictPort
\`\`\`
url: http://localhost:{port}
ready: /
EOF
git -C "$REPO" add .awb/run.md
git -C "$REPO" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q -m "awb: start recipe"

STUB="$WORK/claude-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
mkdir -p public/awb-stack
echo "<!doctype html><title>Coin</title><h1>coin shows tails</h1>" > public/awb-stack/coin.html
git add public/awb-stack
git -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=stub commit -q -m "coin page"
awb prove || echo "stub: prove failed, stopping"
EOF
chmod +x "$STUB"
mkdir -p "$WORK/bin"
ln -s "$AWB" "$WORK/bin/awb"
export PATH="$WORK/bin:$PATH" AWB_CLAUDE="$STUB"

STACK='{"tasks":[
 {"title":"Coin flip page","claims":[{"id":"C1","text":"The page /awb-stack/coin.html shows the heading \"coin shows heads\"."}]},
 {"title":"Coin flip history","claims":[{"id":"C1","text":"The page /awb-stack/history.html lists the last flips."}]}
]}'
(cd "$REPO" && echo "$STACK" | awb stack set --json 2>/dev/null) > "$WORK/stack.json"
T1=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).stack.tasks[0].folder)' "$WORK/stack.json")
mkdir -p "$T1/proof-tests"
cat > "$T1/proof-tests/c1.spec.ts" <<'EOF'
import { test, expect } from "@playwright/test";
test("C1: coin page shows heads", async ({ page }) => {
  await page.goto("/awb-stack/coin.html");
  await expect(page.getByRole("heading", { name: "coin shows heads" })).toBeVisible({ timeout: 3000 });
});
EOF

echo "== 1. a stack of two; the stub fails task 1 at the gate"
RUN=$(cd "$REPO" && awb run --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$AWB_HOME/daemon.json")
for _ in $(seq 1 60); do
  ST=$(curl -sf "http://127.0.0.1:$PORT/api/runs/$RUN" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).state)')
  [ "$ST" = running ] || break
  sleep 3
done
awb tasks 2>/dev/null
[ "$(awb tasks --status failed --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).length)')" = 1 ] || fail "expected one failed task"

echo
echo "== 2. ask the real claude ($MODEL)"
Q="What did you do today, and what failed?"
(cd "$REPO" && echo "$Q" | env -u AWB_CLAUDE awb -p --model "$MODEL" \
  --allowedTools "Bash(awb:*)" "Read" \
  --max-budget-usd 0.5 --output-format stream-json --verbose 2>/dev/null) > "$WORK/answer.jsonl" || true

node - "$WORK/answer.jsonl" <<'JS' || fail "the answer"
const rows = require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const cmds = rows.flatMap((r) => (r.message?.content ?? []).filter((c) => c.type === "tool_use" && c.name === "Bash").map((c) => c.input.command));
const result = rows.findLast((r) => r.type === "result");
console.log("commands the agent ran:");
cmds.forEach((c) => console.log("  " + c));
console.log("\nanswer:\n" + result?.result);
console.log(`\ncost: ${Number(result?.total_cost_usd ?? 0).toFixed(3)} USD, turns: ${result?.num_turns}`);
const a = result?.result ?? "";
const ok = cmds.some((c) => /^awb (tasks|show)/.test(c)) && /coin flip page/i.test(a) && /C1/.test(a) && /fail/i.test(a);
process.exit(ok ? 0 : 1);
JS

echo
echo "PASS"
