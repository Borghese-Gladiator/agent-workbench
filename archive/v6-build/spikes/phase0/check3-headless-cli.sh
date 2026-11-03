#!/usr/bin/env bash
# Check 3: a headless claude -p session runs a task through Bash, calls awb by name, and stops.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

WORK="${WORK:-$(mktemp -d)}"
REPO="$WORK/games"
BIN="$WORK/bin"
LOG="$WORK/awb.log"
BRANCH="awb/phase0-check3"
echo "work dir: $WORK"

git clone -q "$GAMES_REPO" "$REPO"
git -C "$REPO" checkout -q -b "$BRANCH"
mkdir -p "$WORK/no-hooks"
git -C "$REPO" config core.hooksPath "$WORK/no-hooks"

mkdir -p "$BIN"
cat > "$BIN/awb" <<EOF
#!/bin/sh
branch=\$(git rev-parse --abbrev-ref HEAD)
case "\$1" in
  prove)
    echo "prove \$branch" >> "$LOG"
    echo "claim  result"
    echo "C1     pass"
    echo "C2     pass"
    ;;
  ship)
    echo "ship \$branch" >> "$LOG"
    echo "draft PR: https://example.invalid/pr/1"
    ;;
  *) echo "usage: awb prove|ship" >&2; exit 2 ;;
esac
EOF
chmod +x "$BIN/awb"

PLAYBOOK="You work in a task system. For every task, do these steps in order:
1. Make the change. Commit it with git.
2. Run the shell command: awb prove. It prints a claim table.
3. If every claim passes, run the shell command: awb ship.
4. Stop and reply with the PR URL."

START=$(date +%s)
(cd "$REPO" && echo "Task: add one line 'Phase 0 check 3.' at the end of README.md." | PATH="$BIN:$PATH" claude -p \
  --append-system-prompt "$PLAYBOOK" \
  --allowedTools "Read" "Edit" "Write" "Bash(git:*)" "Bash(awb:*)" \
  --output-format stream-json --verbose > "$WORK/session.jsonl") || CODE=$?
CODE=${CODE:-0}
SECS=$(( $(date +%s) - START ))

echo "exit code: $CODE, time: ${SECS}s"
tail -1 "$WORK/session.jsonl" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log("result:",r.subtype,"| cost USD:",r.total_cost_usd,"| turns:",r.num_turns);console.log("reply:",r.result)'
echo "awb log:"
cat "$LOG" 2>/dev/null || true
git -C "$REPO" log --oneline -2
assert_clean "$REPO" || CODE=1

EXPECT="prove $BRANCH
ship $BRANCH"
if [ "$CODE" -eq 0 ] && [ "$(cat "$LOG" 2>/dev/null)" = "$EXPECT" ]; then
  echo "PASS: prove then ship on $BRANCH, session exited by itself"
else
  echo "FAIL: log or exit code not as expected"
  exit 1
fi
