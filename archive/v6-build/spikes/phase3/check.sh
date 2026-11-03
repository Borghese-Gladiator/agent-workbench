#!/usr/bin/env bash
# Phase 3 manual check on the games repo, with the real claude and Playwright agents.
#   1. pass: the scoreboard claims hold on the current code; awb prove passes.
#   2. planted bug: X wins are not counted; awb prove fails the X-win claims.
#   3. independence: the test writer used no file outside the task folder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../phase0/lib.sh"
AWB="$HERE/../../packages/cli/bin/awb"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home"
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT

STACK='{"tasks":[{"title":"Tic-Tac-Toe session scoreboard","claims":[
 {"id":"C1","text":"The page /games/tic-tac-toe/ shows a scoreboard with three counters labeled \"X wins\", \"O wins\" and \"Draws\". All three show 0 when the page loads."},
 {"id":"C2","text":"When X wins a game, the \"X wins\" counter shows 1. The other two counters still show 0."},
 {"id":"C3","text":"When a game ends in a draw, the \"Draws\" counter shows 1."}
]}]}'

recipe() {
  mkdir -p "$1/.awb"
  cat > "$1/.awb/run.md" <<'EOF'
# Run

## start
```sh
npx vite --port {port} --strictPort
```
url: http://localhost:{port}
ready: /games/tic-tac-toe/
EOF
  git -C "$1" add .awb/run.md
  git -C "$1" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q -m "awb: start recipe"
}

echo "== 1. pass case"
scratch_games "$WORK/pass"
git -C "$WORK/pass" checkout -q -b awb/scoreboard-proof
recipe "$WORK/pass"
(cd "$WORK/pass" && echo "$STACK" | "$AWB" stack set 2>/dev/null)
START=$(date +%s)
(cd "$WORK/pass" && "$AWB" prove) && P1=0 || P1=$?
echo "pass case: exit $P1, $(( $(date +%s) - START ))s"
(cd "$WORK/pass" && "$AWB" show 2>/dev/null)
TASK1=$(cd "$WORK/pass" && "$AWB" show --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).folder)')
[ "$P1" -eq 0 ] || fail "awb prove did not pass on the correct code"
assert_clean "$WORK/pass" || fail "the games repo changed"

echo
echo "== 3. independence: the test writer used no file outside its task folder"
node - "$TASK1/proof/writer.jsonl" "$TASK1" <<'JS' || fail "independence"
const fs = require("fs"), path = require("path");
const [file, task] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const outside = [];
let writes = 0;
for (const r of rows) for (const c of r.message?.content ?? []) {
  if (c.type !== "tool_use") continue;
  if (c.name === "mcp__playwright-test__generator_write_test") writes++;
  const p = c.input?.file_path ?? c.input?.path;
  if (p && !path.resolve(task, p).startsWith(task)) outside.push(`${c.name} ${p}`);
}
console.log(`generator_write_test calls: ${writes}; file calls outside the task folder: ${outside.length}`);
outside.forEach((x) => console.log("  " + x));
process.exit(outside.length || !writes ? 1 : 0);
JS


echo
echo "== 2. planted bug: X wins are not counted"
scratch_games "$WORK/bug"
git -C "$WORK/bug" checkout -q -b awb/scoreboard-bug
recipe "$WORK/bug"
perl -pi -e 's/if \(winner === "X" \|\| winner === "O"\) \{/if (winner === "O") {/' "$WORK/bug/games/tic-tac-toe/src/ttt.ts"
git -C "$WORK/bug" diff --stat
git -C "$WORK/bug" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -qam "planted bug: X wins not counted"
(cd "$WORK/bug" && echo "$STACK" | "$AWB" stack set 2>/dev/null)
TASK2=$(cd "$WORK/bug" && "$AWB" show --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).folder)')
mkdir -p "$TASK2/proof-tests"
cp "$TASK1"/proof-tests/c*.spec.ts "$TASK2/proof-tests/"
echo "reused the pass-case specs: $(ls "$TASK2/proof-tests" | tr '\n' ' ')"
(cd "$WORK/bug" && "$AWB" prove) && P2=0 || P2=$?
echo "bug case: exit $P2"
[ "$P2" -ne 0 ] || fail "awb prove passed with the planted bug"
node -e '
const g = JSON.parse(require("fs").readFileSync(process.argv[1]));
const st = Object.fromEntries(g.rows.map((r) => [r.id, r.status]));
console.log("bug case rows:", JSON.stringify(st));
process.exit(st.C2 === "FAIL" && st.C1 === "PASS" ? 0 : 1);
' "$TASK2/proof/gate.json" || fail "expected C2 to fail and C1 to pass"
[ ! -e "$TASK2/proof/writer.jsonl" ] || fail "the bug case started a test writer"

echo
echo "PASS"
