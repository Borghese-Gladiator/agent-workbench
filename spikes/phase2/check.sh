#!/usr/bin/env bash
# Phase 2 manual check with the real claude: a tool call reaches the live feed in under 2 s,
# token totals arrive, and the chat keeps working when the daemon stops.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWB="$HERE/../../packages/cli/bin/awb"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
export AWB_HOME="$WORK/home"
MODEL="${MODEL:-haiku}"
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
FEED_PID=""
cleanup() {
  [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
  "$AWB" daemon stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

git init -q -b main "$WORK/repo"
git -C "$WORK/repo" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q --allow-empty -m init
cd "$WORK/repo"

echo "== 1. open the live feed"
URL=$("$AWB" ui --no-open 2>/dev/null)
node "$HERE/feed-client.mjs" "${URL}api/feed" > "$WORK/feed.jsonl" &
FEED_PID=$!
sleep 0.5

echo "== 2. ask the chat to run one Bash command"
echo "Run this exact shell command once: node -e \"require('fs').writeFileSync('$WORK/tool-done', String(Date.now()))\". Then reply with the word done." \
  | "$AWB" -p --model "$MODEL" --allowedTools "Bash(node:*)" > "$WORK/out1.txt" 2>"$WORK/err1.txt"
cat "$WORK/out1.txt"
sleep 0.5

echo "== 3. the tool call shows in the feed in under 2 s"
node - "$WORK" <<'JS'
const fs = require("fs");
const dir = process.argv[2];
const rows = fs.readFileSync(`${dir}/feed.jsonl`, "utf8").split("\n").filter(Boolean).map(JSON.parse);
console.log("feed hooks:", rows.map((r) => r.hook ?? "(register)").join(" > "));
const done = Number(fs.readFileSync(`${dir}/tool-done`, "utf8"));
const post = rows.find((r) => r.hook === "PostToolUse" && r.tool === "Bash");
if (!post) { console.log("FAIL: no PostToolUse Bash event in the feed"); process.exit(1); }
const ms = post.t - done;
console.log(`tool finished -> feed: ${ms} ms`);
if (ms > 2000) { console.log("FAIL: over 2 s"); process.exit(1); }
const last = rows.at(-1);
if (!last.usage || !(last.usage.output > 0)) { console.log("FAIL: no token totals in the feed"); process.exit(1); }
console.log("tokens:", JSON.stringify(last.usage), "| final state:", last.state);
if (last.state !== "ended") { console.log("FAIL: session not ended in the feed"); process.exit(1); }
JS

echo "== 4. stop the daemon during a chat; the chat keeps working"
(
  for _ in $(seq 1 100); do [ -f "$WORK/sleeping" ] && break; sleep 0.2; done
  "$AWB" daemon stop >/dev/null 2>&1
  date +%s > "$WORK/stopped-at"
) &
START=$(date +%s)
CODE=0
echo "Run these two shell commands, one at a time, in this order: 1) touch $WORK/sleeping && sleep 4  2) echo still-here > $WORK/after-stop. Then reply with the word finished." \
  | "$AWB" -p --model "$MODEL" --allowedTools "Bash(touch:*)" "Bash(sleep:*)" "Bash(echo:*)" > "$WORK/out2.txt" 2>"$WORK/err2.txt" || CODE=$?
wait
echo "exit code: $CODE, time: $(( $(date +%s) - START ))s"
cat "$WORK/out2.txt"
grep "awb:" "$WORK/err2.txt" || true
[ -f "$WORK/stopped-at" ] || fail "the daemon was not stopped during the chat"
"$AWB" daemon status >/dev/null 2>&1 && fail "the daemon is still up"
[ "$CODE" -eq 0 ] || fail "claude exited with $CODE"
[ "$(cat "$WORK/after-stop" 2>/dev/null)" = "still-here" ] || fail "the chat did not run the command after the stop"
echo "the chat finished its work after the daemon stopped"

echo
echo "PASS"
