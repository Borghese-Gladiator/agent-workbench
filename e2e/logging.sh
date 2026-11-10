#!/usr/bin/env bash
# End-to-end check of the structured log, with a stub claude (no tokens, no GitHub, no Docker).
# A task session sleeps past AWB_TASK_TIMEOUT_MIN=1, so the runner stops the stack.
# Then awb logs must show the run, the timeout and the failed task.
# Usage: bash e2e/logging.sh   (WORK=<dir> keeps the files; it takes about 70 s)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWB="$HERE/../packages/cli/bin/awb"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000 AWB_TASK_TIMEOUT_MIN=1 AWB_NOTIFY_CMD="$WORK/notify"
echo "work dir: $WORK"
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL: $1"; exit 1; }

cat > "$WORK/notify" <<EOF
#!/bin/sh
echo "\$1 | \$2" >> "$WORK/notices.txt"
EOF
chmod +x "$WORK/notify"

REPO="$WORK/repo"
mkdir -p "$REPO/.awb"
git -C "$REPO" init -q -b main
cat > "$REPO/.awb/run.md" <<'EOF'
## start
```sh
python3 -m http.server {port}
```
url: http://localhost:{port}
ready: /
EOF
git -C "$REPO" add .awb/run.md
git -C "$REPO" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q -m "awb: start recipe"
git -C "$REPO" remote add origin "$REPO"

STUB="$WORK/claude-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":5}}}'
sleep 120
EOF
chmod +x "$STUB"
mkdir -p "$WORK/bin"
ln -sf "$AWB" "$WORK/bin/awb"
export PATH="$WORK/bin:$PATH" AWB_CLAUDE="$STUB"

STACK='{"tasks":[
 {"title":"Slow task","claims":[{"id":"C1","text":"The page / shows a heading."}]},
 {"title":"Never starts","claims":[{"id":"C1","text":"The page / shows a list."}]}
]}'
(cd "$REPO" && echo "$STACK" | awb stack set --json 2>/dev/null) > "$WORK/stack.json"
T1=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).stack.tasks[0].id)' "$WORK/stack.json")
T2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).stack.tasks[1].id)' "$WORK/stack.json")

echo "== 1. awb run --wait: the stub sleeps past the 1 min limit"
(cd "$REPO" && awb logs --follow --task "${T1:0:8}" 2>/dev/null > "$WORK/follow.txt") &
FOLLOW=$!
start=$(date +%s)
(cd "$REPO" && awb run --wait 2>/dev/null) && fail "awb run --wait exited 0 for a stopped run" || true
took=$(( $(date +%s) - start ))
echo "run took $took s"
[ "$took" -lt 90 ] || fail "the 1 min time limit took $took s: the timeout did not stop the session"
sleep 2
kill "$FOLLOW" 2>/dev/null || true

echo
echo "== 2. awb logs --task $T1"
awb logs --task "${T1:0:8}" 2>/dev/null | tee "$WORK/task.txt"
grep -q "INFO  runner.session.start task=${T1:0:8}" "$WORK/task.txt" || fail "no session.start line"
grep -q "WARN  runner.session.ended task=${T1:0:8}.*how=timeout after 1 min" "$WORK/task.txt" || fail "no session.ended line with the timeout"
grep -q "ERROR runner.task.failed task=${T1:0:8}.*session: timeout after 1 min" "$WORK/task.txt" || fail "no task.failed line with the reason"
grep -q "runner.run.end.*state=stopped" "$WORK/task.txt" || fail "no run.end line"
if awb logs --task "${T2:0:8}" 2>/dev/null | grep -q session.start; then fail "task 2 started"; fi

echo
echo "== 3. awb logs --level error --since 1h"
awb logs --level error --since 1h 2>/dev/null | tee "$WORK/errors.txt"
[ "$(grep -c . "$WORK/errors.txt")" -ge 1 ] || fail "no error line"
if grep -q "cli.error command=run" "$WORK/errors.txt"; then fail "a stopped run is logged as a CLI error"; fi
if grep -qv " ERROR " "$WORK/errors.txt"; then fail "--level error shows a line that is not an error"; fi

echo
echo "== 4. awb logs --follow printed the lines while the run went on"
cat "$WORK/follow.txt"
grep -q "runner.task.failed" "$WORK/follow.txt" || fail "--follow did not print task.failed"

echo
echo "== 5. a failed CLI command writes cli.error, and a secret does not reach the file"
SECRET="sk-ant-$(printf 'a%.0s' $(seq 1 30))"
(cd "$REPO" && awb retry "$SECRET" 2>/dev/null) && fail "awb retry of a bad id exited 0" || true
awb logs --source cli 2>/dev/null | tee "$WORK/cli.txt"
grep -q "ERROR cli.error.*command=retry" "$WORK/cli.txt" || fail "no cli.error line"
if grep -rq "$SECRET" "$AWB_HOME/logs"; then fail "the secret is in the log file"; fi
cat "$AWB_HOME"/logs/awb.*.jsonl | grep -q "Anthropic key removed" || fail "the secret was not marked as removed"

echo
echo "== 6. the notice and the daemon lines"
cat "$WORK/notices.txt" 2>/dev/null || true
grep -q "stack stopped | Slow task: .*timeout after 1 min" "$WORK/notices.txt" || fail "no stop notice"
awb logs --source daemon 2>/dev/null | grep -q "daemon.start" || fail "no daemon.start line"

echo
echo "== 7. every line is valid JSON with ts, level, source and event"
cat "$AWB_HOME"/logs/awb.*.jsonl | node -e '
const lines = require("fs").readFileSync(0, "utf8").trim().split("\n");
for (const l of lines) { const j = JSON.parse(l); for (const k of ["ts","level","source","event"]) if (!j[k]) throw new Error("missing " + k + ": " + l); }
console.log(lines.length + " lines, all valid");
'

echo
echo "PASS"
