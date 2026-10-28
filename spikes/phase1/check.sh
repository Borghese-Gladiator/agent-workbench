#!/usr/bin/env bash
# Phase 1 manual check: two repos in one UI, an isolated AWB_HOME, and a daemon restart.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AWB="$ROOT/packages/cli/bin/awb"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
echo "work dir: $WORK"

fail() { echo "FAIL: $1"; exit 1; }
cleanup() {
  for h in "$WORK/home-a" "$WORK/home-b"; do AWB_HOME="$h" "$AWB" daemon stop >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

cat > "$WORK/claude-stub" <<'EOF'
#!/bin/sh
for last; do :; done
{ echo "last arg: $last"; echo "AWB_HOME=$AWB_HOME"; } >> "$STUB_LOG"
sleep "${STUB_SLEEP:-0}"
EOF
chmod +x "$WORK/claude-stub"
export AWB_CLAUDE="$WORK/claude-stub" STUB_LOG="$WORK/stub.log"

for r in repo1 repo2; do
  git init -q -b main "$WORK/$r"
  git -C "$WORK/$r" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q --allow-empty -m init
done

sessions() { AWB_HOME="$1" "$AWB" sessions --json 2>/dev/null; }
count() { node -e 'const l=JSON.parse(require("fs").readFileSync(0));console.log(l.filter(s=>s.repo===process.argv[1]).length)' "$2" <<<"$(sessions "$1")"; }

echo "== 1. start awb in two repos at the same time"
export AWB_HOME="$WORK/home-a"
(cd "$WORK/repo1" && STUB_SLEEP=3 "$AWB" --resume) 2>"$WORK/r1.err" &
(cd "$WORK/repo2" && STUB_SLEEP=3 "$AWB" --resume) 2>"$WORK/r2.err" &
sleep 1.5

echo "== 2. both sessions show in the UI while open"
URL=$("$AWB" ui --no-open 2>/dev/null)
curl -sf "$URL" | grep -q 'EventSource("/api/feed")' || fail "UI page does not load the live feed"
PAGE=$(curl -sN -m 1 "${URL}api/feed" || true)
for r in repo1 repo2; do grep -q "$WORK/$r" <<<"$PAGE" || fail "$r is not in the UI feed"; done
[ "$(grep -o '"ended_at":null' <<<"$PAGE" | wc -l | tr -d ' ')" = 2 ] || fail "UI feed does not show 2 open sessions"
echo "UI at $URL shows repo1 and repo2 as open"
wait
[ "$(sessions "$AWB_HOME" | grep -o '"ended_at":null' | wc -l | tr -d ' ')" = 0 ] || fail "sessions did not end"
grep -q "^last arg: --resume$" "$STUB_LOG" || fail "--resume did not reach claude as the last argument"
grep -q "^AWB_HOME=$WORK/home-a$" "$STUB_LOG" || fail "AWB_HOME not in claude env"
head -1 "$WORK/r1.err" | grep -q "AWB_HOME=$WORK/home-a" || fail "first line does not name AWB_HOME"
echo "sessions ended; --resume and AWB_HOME reached claude; first line names AWB_HOME"

echo "== 3. a second AWB_HOME starts its own daemon, and its session is not in the first UI"
(cd "$WORK/repo1" && AWB_HOME="$WORK/home-b" "$AWB" 2>/dev/null)
PA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$WORK/home-a/daemon.json")
PB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$WORK/home-b/daemon.json")
[ "$PA" != "$PB" ] || fail "both homes use port $PA"
[ "$(count "$WORK/home-b" "$WORK/repo1")" = 1 ] || fail "home-b does not have its session"
[ "$(count "$WORK/home-a" "$WORK/repo1")" = 1 ] || fail "home-b session leaked into home-a"
echo "home-a port $PA, home-b port $PB; home-a still has 1 repo1 session"

echo "== 4. stop a daemon; awb starts a new one and keeps the history"
OLD=$(AWB_HOME="$WORK/home-a" "$AWB" daemon status 2>/dev/null)
AWB_HOME="$WORK/home-a" "$AWB" daemon stop >/dev/null 2>&1
sleep 0.5
AWB_HOME="$WORK/home-a" "$AWB" daemon status >/dev/null 2>&1 && fail "daemon still running"
(cd "$WORK/repo2" && AWB_HOME="$WORK/home-a" "$AWB" 2>/dev/null)
NEW=$(AWB_HOME="$WORK/home-a" "$AWB" daemon status 2>/dev/null)
[ "$OLD" != "$NEW" ] || fail "no new daemon"
[ "$(count "$WORK/home-a" "$WORK/repo2")" = 2 ] || fail "history lost after restart"
echo "old: $OLD; new: $NEW; repo2 has 2 sessions"

echo "== 5. awb doctor"
AWB_HOME="$WORK/home-a" "$AWB" doctor 2>/dev/null || true

echo
echo "PASS"
