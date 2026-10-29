#!/usr/bin/env bash
# Phase 4 manual check on the games repo, with real GitHub:
#   1. refusal: awb ship refuses when the source changed after awb prove.
#   2. ship: a draft PR opens with a video link for each claim, and each link downloads.
#   3. sync: close the PR; the task becomes closed.
# Usage: SPECS=<a phase 3 task folder>/proof-tests bash spikes/phase4/check.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../phase0/lib.sh"
AWB="$HERE/../../packages/cli/bin/awb"
REMOTE="${REMOTE:-https://github.com/Borghese-Gladiator/browser-games__ai.git}"
: "${SPECS:?set SPECS to a proof-tests folder from a phase 3 pass run}"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home"
BRANCH="awb/phase4-check-$(date +%s)"
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT

STACK='{"tasks":[{"title":"Tic-Tac-Toe session scoreboard (awb phase 4 check)","claims":[
 {"id":"C1","text":"The page /games/tic-tac-toe/ shows a scoreboard with three counters labeled \"X wins\", \"O wins\" and \"Draws\". All three show 0 when the page loads."},
 {"id":"C2","text":"When X wins a game, the \"X wins\" counter shows 1. The other two counters still show 0."},
 {"id":"C3","text":"When a game ends in a draw, the \"Draws\" counter shows 1."}
]}]}'

REPO="$WORK/games"
scratch_games "$REPO"
git -C "$REPO" remote set-url origin "$REMOTE"
git -C "$REPO" fetch -q origin "+refs/heads/main:refs/remotes/origin/main"
git -C "$REPO" remote set-head origin main
git -C "$REPO" checkout -q -b "$BRANCH" origin/main
mkdir -p "$REPO/.awb"
cat > "$REPO/.awb/run.md" <<'EOF'
## start
```sh
npx vite --port {port} --strictPort
```
url: http://localhost:{port}
ready: /games/tic-tac-toe/
EOF
git -C "$REPO" add .awb/run.md
git -C "$REPO" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q -m "awb: start recipe"

(cd "$REPO" && echo "$STACK" | "$AWB" stack set 2>/dev/null)
TASK=$(cd "$REPO" && "$AWB" show --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).folder)')
mkdir -p "$TASK/proof-tests"
cp "$SPECS"/c*.spec.ts "$TASK/proof-tests/"
(cd "$REPO" && "$AWB" prove) || fail "awb prove did not pass"

echo
echo "== 1. refusal: a file changed after awb prove"
echo "x" > "$REPO/stray.txt"
(cd "$REPO" && "$AWB" ship) && fail "awb ship opened a PR with a dirty tree" || echo "refused, as expected"
rm "$REPO/stray.txt"

echo
echo "== 2. ship"
(cd "$REPO" && "$AWB" ship) || fail "awb ship failed"
PR=$(cd "$REPO" && "$AWB" show --json 2>/dev/null | node -e 'const t=JSON.parse(require("fs").readFileSync(0)); if (t.status!=="done") process.exit(1); console.log(t.pr_number)') \
  || fail "the task is not done"
(cd "$REPO" && gh pr view "$PR" --json isDraft,body,url) > "$WORK/pr.json"
node -e '
const pr = JSON.parse(require("fs").readFileSync(process.argv[1]));
console.log("PR:", pr.url, "| draft:", pr.isDraft);
const links = [...pr.body.matchAll(/\| (C\d) \|.*\[video\]\((\S+)\)/g)].map((m) => [m[1], m[2]]);
console.log("video links:", links.map(([c]) => c).join(","));
require("fs").writeFileSync(process.argv[2], links.map(([, u]) => u).join("\n"));
process.exit(pr.isDraft && links.length === 3 ? 0 : 1);
' "$WORK/pr.json" "$WORK/links.txt" || fail "the PR is not a draft with 3 video links"
while read -r u || [ -n "$u" ]; do
  code=$(curl -sL -o "$WORK/v.webm" -w "%{http_code}" "$u")
  size=$(wc -c < "$WORK/v.webm" | tr -d ' ')
  echo "  $code ${size}B $u"
  [ "$code" = 200 ] && [ "$size" -gt 1000 ] || fail "video link does not download"
done < "$WORK/links.txt"

echo
echo "== 3. sync: close the PR"
(cd "$REPO" && gh pr close "$PR" >/dev/null)
git -C "$REPO" push -q origin --delete "$BRANCH"
PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$AWB_HOME/daemon.json")
curl -sf -X POST "http://127.0.0.1:$PORT/api/sync" >/dev/null
STATUS=$(cd "$REPO" && "$AWB" show --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).status)')
echo "task status after close: $STATUS"
[ "$STATUS" = closed ] || fail "PR sync did not set closed"

echo
echo "PASS"
