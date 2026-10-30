#!/usr/bin/env bash
# Acceptance test for v6 (PROPOSAL 6.2), with the real claude and real GitHub.
# Usage: bash spikes/acceptance/run.sh setup|single|bug|stack|ask   (WORK=<dir> keeps state between parts)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWB="$HERE/../../packages/cli/bin/awb"
REMOTE="${REMOTE:-https://github.com/Borghese-Gladiator/browser-games__ai.git}"
LOCAL_GAMES="${LOCAL_GAMES:-$HOME/GitHub/wip-browser-games}"
: "${WORK:?set WORK to a folder for the run state}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
export AWB_HOME="$WORK/home"
export AWB_TASK_BUDGET_USD="${AWB_TASK_BUDGET_USD:-5}" AWB_WRITER_BUDGET_USD="${AWB_WRITER_BUDGET_USD:-3}"
REPO="$WORK/games"
mkdir -p "$WORK/bin"
ln -sf "$AWB" "$WORK/bin/awb"
export PATH="$WORK/bin:$PATH"
TOOLS=(--permission-mode acceptEdits --allowedTools Read Edit Write Glob Grep Bash)

chat() {
  local name=$1 budget=$2 prompt=$3
  echo "prompt: $prompt"
  local start=$(date +%s)
  (cd "$REPO" && echo "$prompt" | awb -p "${TOOLS[@]}" --max-budget-usd "$budget" --output-format stream-json --verbose) > "$WORK/$name.jsonl" 2> "$WORK/$name.err" || true
  node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const awb = rows.flatMap((r) => (r.message?.content ?? []).filter((c) => c.type === "tool_use" && c.name === "Bash" && /(^|[;&|]\s*|\n)awb /.test(c.input.command)).map((c) => c.input.command.split("\n")[0].slice(0, 140)));
const res = rows.findLast((r) => r.type === "result");
console.log("awb commands:"); awb.forEach((c) => console.log("  " + c));
console.log(`result: ${res?.subtype} | turns ${res?.num_turns} | ${Number(res?.total_cost_usd ?? 0).toFixed(2)} USD`);
console.log("final message:\n" + (res?.result ?? "").slice(0, 3000));
' "$WORK/$name.jsonl"
  echo "time: $(( $(date +%s) - start )) s"
}

case "${1:-}" in
setup)
  rm -rf "$REPO"
  git clone -q "$REMOTE" "$REPO"
  cp -cR "$LOCAL_GAMES/node_modules" "$REPO/node_modules"
  mkdir -p "$WORK/hooks"
  cat > "$WORK/hooks/pre-push" <<'EOF'
#!/bin/sh
while read -r _ _ remote_ref _; do
  [ "$remote_ref" = "refs/heads/main" ] && { echo "acceptance: push to main refused"; exit 1; }
done
exit 0
EOF
  chmod +x "$WORK/hooks/pre-push"
  git -C "$REPO" config core.hooksPath "$WORK/hooks"
  git -C "$REPO" config user.email "awb-acceptance@example.com"
  git -C "$REPO" config user.name "awb acceptance"
  git -C "$REPO" log --oneline -1
  echo "clone ready: $REPO"
  ;;
single)
  git -C "$REPO" checkout -q main
  chat single 8 "Add an Undo button to Tic-Tac-Toe. It takes back the last move. It is disabled when there is no move to take back, and after a game ends."
  ;;
bug)
  T=$(awb tasks --json 2>/dev/null | node -e 'const t=JSON.parse(require("fs").readFileSync(0)).find((x)=>x.status==="done"); console.log(t.branch, t.base, t.id)')
  read -r BR BASE TID <<< "$T"
  git -C "$REPO" fetch -q origin "$BR"
  git -C "$REPO" checkout -q -B "awb/acceptance-bug-$(date +%s)" "origin/$BR"
  FILES=$(git -C "$REPO" diff --name-only "origin/$BASE...origin/$BR" -- games/ | grep -v '\.test\.' || true)
  echo "revert the feature code: $FILES"
  git -C "$REPO" checkout "origin/$BASE" -- $FILES
  git -C "$REPO" commit -qm "planted bug: remove the Undo feature code"
  STACK=$(awb show "$TID" --json 2>/dev/null | node -e 'const t=JSON.parse(require("fs").readFileSync(0)); console.log(JSON.stringify({tasks:[{title:t.title+" (planted bug)",claims:t.claims}]}))')
  (cd "$REPO" && echo "$STACK" | awb stack set 2>/dev/null)
  NEW=$(cd "$REPO" && awb show --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).folder)')
  OLD=$(awb show "$TID" --json 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).folder)')
  mkdir -p "$NEW/proof-tests"
  cp "$OLD"/proof-tests/*.spec.ts "$NEW/proof-tests/"
  echo "reused the proof tests of the shipped task"
  (cd "$REPO" && awb prove) && echo "UNEXPECTED: prove passed" || echo "prove failed, as expected"
  (cd "$REPO" && awb ship) && echo "UNEXPECTED: ship opened a PR" || echo "ship refused, as expected"
  ;;
stack)
  git -C "$REPO" checkout -q main
  BASE="awb/acceptance-stack-$(date +%s)"
  git -C "$REPO" checkout -q -b "$BASE"
  git -C "$REPO" push -q -u origin "$BASE"
  echo "stack base: $BASE"
  chat stack 6 "Add a match mode to Tic-Tac-Toe, built as a stack of three tasks with one PR each: (1) a \"Best of 3\" toggle that, when on, shows the match score as \"Match: X 0 - O 0\"; (2) when a player wins 2 games in best-of-3 mode, show the banner \"X wins the match!\" (or O) and disable the board until a new match starts; (3) a \"New match\" button that resets the match score and hides the banner. Run the stack and wait until awb run is no longer running, then report each task and its PR."
  ;;
ask)
  (cd "$REPO" && echo "What did you do today, and what failed?" | awb -p --model haiku --allowedTools "Bash(awb:*)" --max-budget-usd 0.5 --output-format stream-json --verbose) > "$WORK/ask.jsonl" 2>/dev/null || true
  node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
rows.flatMap((r) => (r.message?.content ?? []).filter((c) => c.type === "tool_use")).forEach((c) => console.log("ran: " + c.input.command));
const res = rows.findLast((r) => r.type === "result");
console.log(res?.result); console.log(`cost ${Number(res?.total_cost_usd ?? 0).toFixed(3)} USD`);
' "$WORK/ask.jsonl"
  ;;
*)
  echo "usage: $0 setup|single|bug|stack|ask"; exit 2 ;;
esac
