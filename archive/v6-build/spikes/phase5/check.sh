#!/usr/bin/env bash
# Phase 5 manual check on the games repo, with real GitHub and a stub claude (no tokens):
#   1. a stack of three gives three stacked draft PRs in order.
#   2. a planted bug in task 2 fails task 2, and task 3 does not start.
#   3. after the fix, awb retry ships task 2 and task 3.
#   4. clean up: close the PRs, delete the branches and the releases.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../phase0/lib.sh"
AWB="$HERE/../../packages/cli/bin/awb"
REMOTE="${REMOTE:-https://github.com/Borghese-Gladiator/browser-games__ai.git}"
SLUG="${REMOTE#https://github.com/}"
SLUG="${SLUG%.git}"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000
TS=$(date +%s)
BASE="awb/phase5-base-$TS"
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT

REPO="$WORK/games"
scratch_games "$REPO"
git -C "$REPO" remote set-url origin "$REMOTE"
git -C "$REPO" fetch -q origin "+refs/heads/main:refs/remotes/origin/main"
git -C "$REPO" remote set-head origin main
git -C "$REPO" checkout -q -b "$BASE" origin/main
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
git -C "$REPO" push -q -u origin "$BASE"

STUB="$WORK/claude-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
set -u
prompt=$(cat)
n=$(printf '%s\n' "$prompt" | sed -n 's/^You work on one task of a stack: "Part \([0-9]\)".*/\1/p')
echo "stub: part $n in $(pwd)"
word="part $n done"
[ "$n" = 2 ] && [ -e "$PLANT_BUG" ] && word="part 2 broken"
mkdir -p public/awb-stack
echo "<!doctype html><title>Part $n</title><h1>$word</h1>" > "public/awb-stack/part$n.html"
git add public/awb-stack
git -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=stub commit -q -m "part $n" || true
awb prove || { echo "stub: prove failed"; exit 0; }
awb ship
EOF
chmod +x "$STUB"
mkdir -p "$WORK/bin"
ln -s "$AWB" "$WORK/bin/awb"
export AWB_CLAUDE="$STUB" PLANT_BUG="$WORK/plant-bug" PATH="$WORK/bin:$PATH"
touch "$PLANT_BUG"

claims() { printf '{"title":"Part %s","claims":[{"id":"C1","text":"The page /awb-stack/part%s.html shows the heading \\"part %s done\\"."}]}' "$1" "$1" "$1"; }
(cd "$REPO" && echo "{\"tasks\":[$(claims 1),$(claims 2),$(claims 3)]}" | awb stack set --json 2>/dev/null) > "$WORK/stack.json"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1])).stack;
for (const t of s.tasks) console.log(`${t.id} ${t.branch} base=${t.base} ${t.folder}`);
' "$WORK/stack.json" | tee "$WORK/tasks.txt"
while read -r id branch base folder; do
  n=$(echo "$branch" | sed -n 's/^awb\/part-\([0-9]\).*/\1/p')
  mkdir -p "$folder/proof-tests"
  cat > "$folder/proof-tests/c1.spec.ts" <<EOF
import { test, expect } from "@playwright/test";
test("C1: part $n page shows its heading", async ({ page }) => {
  await page.goto("/awb-stack/part$n.html");
  await expect(page.getByRole("heading", { name: "part $n done" })).toBeVisible();
});
EOF
done < "$WORK/tasks.txt"

wait_run() {
  local id=$1 port st
  port=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$AWB_HOME/daemon.json")
  for _ in $(seq 1 120); do
    st=$(curl -sf "http://127.0.0.1:$port/api/runs/$id" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.state, r.reason ?? "")')
    case "$st" in running*) sleep 5 ;; *) echo "$st"; return ;; esac
  done
  echo "timeout"
}
statuses() {
  local port
  port=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$AWB_HOME/daemon.json")
  while read -r id _; do
    curl -sf "http://127.0.0.1:$port/api/tasks/$id" | node -e 'const t=JSON.parse(require("fs").readFileSync(0));console.log(t.status, t.pr_url ?? "-")'
  done < "$WORK/tasks.txt"
}

echo
echo "== 2. planted bug in task 2"
RUN=$(cd "$REPO" && awb run --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
R=$(wait_run "$RUN")
echo "run: $R"
statuses | tee "$WORK/s1.txt"
[ "$(cut -d' ' -f1 "$WORK/s1.txt" | tr '\n' ' ')" = "done failed waiting " ] || fail "expected done failed waiting"

echo
echo "== 3. fix and retry"
rm "$PLANT_BUG"
T2=$(sed -n 2p "$WORK/tasks.txt" | cut -d' ' -f1)
RUN=$(awb retry "$T2" --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
R=$(wait_run "$RUN")
echo "run: $R"
statuses | tee "$WORK/s2.txt"
[ "$(cut -d' ' -f1 "$WORK/s2.txt" | tr '\n' ' ')" = "done done done " ] || fail "expected done done done"

echo
echo "== 1. three stacked draft PRs in order"
PRS=$(cut -d' ' -f2 "$WORK/s2.txt" | sed 's|.*/||')
OK=1
prev="$BASE"
i=0
for pr in $PRS; do
  i=$((i + 1))
  read -r draft base head < <(gh pr view "$pr" -R "$SLUG" --json isDraft,baseRefName,headRefName -q '"\(.isDraft) \(.baseRefName) \(.headRefName)"')
  echo "PR #$pr draft=$draft base=$base head=$head"
  [ "$draft" = true ] && [ "$base" = "$prev" ] || OK=0
  prev="$head"
done
[ "$i" = 3 ] && [ "$OK" = 1 ] || FAILED="the PRs do not stack"

echo
echo "== 4. clean up"
for pr in $PRS; do
  gh pr close "$pr" -R "$SLUG" >/dev/null
  gh release delete "awb-proof-$pr" -R "$SLUG" --yes --cleanup-tag >/dev/null 2>&1 || true
done
while read -r _ branch _; do git -C "$REPO" push -q origin --delete "$branch" || true; done < "$WORK/tasks.txt"
git -C "$REPO" push -q origin --delete "$BASE" || true
echo "closed PRs: $(echo $PRS)"

[ -z "${FAILED:-}" ] || fail "$FAILED"
echo
echo "PASS"
