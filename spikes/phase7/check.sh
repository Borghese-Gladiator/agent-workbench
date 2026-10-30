#!/usr/bin/env bash
# Phase 7 manual check, local only, no tokens. A stub stack of three gives a passed task, a failed task
# and a waiting task. Then ui-check.mjs does the browser steps of the plan and saves a screenshot of each view.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../phase0/lib.sh"
AWB="$HERE/../../packages/cli/bin/awb"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000
echo "work dir: $WORK"
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT

REPO="$WORK/games"
scratch_games "$REPO"
git -C "$REPO" remote set-url origin "$REPO"
git -C "$REPO" checkout -q -b awb/phase7-base
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
prompt=$(cat)
n=$(printf '%s\n' "$prompt" | sed -n 's/^You work on one task of a stack: "Part \([0-9]\)".*/\1/p')
word="part $n done"
[ "$n" = 2 ] && word="part 2 broken"
mkdir -p public/awb-stack
echo "<!doctype html><title>Part $n</title><h1>$word</h1>" > "public/awb-stack/part$n.html"
git add public/awb-stack
git -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=stub commit -q -m "part $n"
awb prove
EOF
chmod +x "$STUB"
mkdir -p "$WORK/bin"
ln -s "$AWB" "$WORK/bin/awb"
export PATH="$WORK/bin:$PATH" AWB_CLAUDE="$STUB"

claims() { printf '{"title":"Part %s","claims":[{"id":"C1","text":"The page /awb-stack/part%s.html shows the heading \\"part %s done\\"."}]}' "$1" "$1" "$1"; }
(cd "$REPO" && echo "{\"tasks\":[$(claims 1),$(claims 2),$(claims 3)]}" | awb stack set --json 2>/dev/null) > "$WORK/stack.json"
node -e 'for (const t of JSON.parse(require("fs").readFileSync(process.argv[1])).stack.tasks) console.log(t.id, t.folder)' "$WORK/stack.json" > "$WORK/tasks.txt"
n=0
while read -r _ folder; do
  n=$((n + 1))
  mkdir -p "$folder/proof-tests"
  cat > "$folder/proof-tests/c1.spec.ts" <<EOF
import { test, expect } from "@playwright/test";
test("C1: part $n page shows its heading", async ({ page }) => {
  await page.goto("/awb-stack/part$n.html");
  await expect(page.getByRole("heading", { name: "part $n done" })).toBeVisible({ timeout: 3000 });
});
EOF
done < "$WORK/tasks.txt"

PORT=""
run_stack() {
  local run st
  run=$(cd "$REPO" && awb run --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
  PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$AWB_HOME/daemon.json")
  for _ in $(seq 1 60); do
    st=$(curl -sf "http://127.0.0.1:$PORT/api/runs/$run" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).state)')
    [ "$st" = running ] || break
    sleep 3
  done
}

echo "== 1. run: task 1 passes the gate (no GitHub, so no ship)"
run_stack
T1=$(sed -n 1p "$WORK/tasks.txt" | cut -d' ' -f1)
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
new DatabaseSync(process.argv[1]).prepare("UPDATE tasks SET status = ?, fail_reason = NULL, pr_number = 1, pr_url = ? WHERE id = ?")
  .run("done", "https://github.com/example/games/pull/1", process.argv[2]);
' "$AWB_HOME/awb.db" "$T1"
echo "marked task 1 done with a fake PR link"

echo "== 2. run again: task 2 fails the gate, task 3 waits"
run_stack
awb tasks 2>/dev/null

echo
echo "== browser steps"
node "$HERE/ui-check.mjs" "http://127.0.0.1:$PORT/" "$WORK/tasks.txt" "${SHOTS:-$WORK/shots}"
