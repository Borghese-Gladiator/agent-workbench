#!/usr/bin/env bash
# End-to-end check of repo-test claims and the daemon run file, with a stub test writer (no tokens, no GitHub).
# A repo under AWB_TEAM_ROOTS gets its run file from awb repo set. The stub writes one passing and one failing test in .awb-proof.
# Then awb prove must pass C1, fail C2, and leave no awb file in the repo.
# Usage: bash e2e/repo-test.sh   (WORK=<dir> keeps the files)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWB="$HERE/../packages/cli/bin/awb"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000 AWB_NOTIFY=0 AWB_TEAM_ROOTS="$WORK/team"
echo "work dir: $WORK"
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL: $1"; exit 1; }

REPO="$WORK/team/lib"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo 'export const add = (a, b) => a + b;' > "$REPO/add.mjs"
git -C "$REPO" add add.mjs
git -C "$REPO" -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -q -m "add"
git -C "$REPO" checkout -q -b awb/add

cat > "$WORK/writer" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
cat > .awb-proof/c1.test.mjs <<'T'
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../add.mjs";
test("C1: add(2, 3) is 5", () => assert.equal(add(2, 3), 5));
T
cat > .awb-proof/c2.test.mjs <<'T'
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../add.mjs";
test("C2: add(2, 2) is 5", () => assert.equal(add(2, 2), 5));
T
echo '{"type":"result","subtype":"success","num_turns":2,"total_cost_usd":0.12}'
EOF
chmod +x "$WORK/writer"
export AWB_WRITER_CLAUDE="$WORK/writer"

cd "$REPO"
echo "== 1. awb repo show: no run file, and a team repo"
"$AWB" repo show 2>/dev/null | tee "$WORK/show0.txt" && fail "repo show exited 0 with no run file" || true
grep -q "team repo" "$WORK/show0.txt" || fail "the repo is not shown as a team repo"

echo "== 2. awb repo set"
printf '## test\n```sh\nnode --test --test-reporter=junit --test-reporter-destination={report} {tests}\n```\n' | "$AWB" repo set 2>/dev/null | tee "$WORK/show1.txt"
grep -q "run file: daemon" "$WORK/show1.txt" || fail "the run file does not come from the daemon"

echo '{"tasks":[{"title":"add","claims":[{"id":"C1","text":"add(2, 3) is 5","proof":"test"},{"id":"C2","text":"add(2, 2) is 5","proof":"test"}]}]}' | "$AWB" stack set 2>/dev/null

echo "== 3. awb prove"
"$AWB" prove 2>"$WORK/prove.err" | tee "$WORK/prove.txt" && fail "prove passed with a failing claim" || true
grep -q "^C1    PASS" "$WORK/prove.txt" || fail "C1 did not pass"
grep -q "^C2    FAIL.*not passed" "$WORK/prove.txt" || fail "C2 did not fail"
grep -q "test writer: success, 2 turns, 0.12 USD, limit 30 min" "$WORK/prove.txt" || fail "no writer report"

echo "== 4. no awb file in the repo"
[ -z "$(git status --porcelain)" ] || { git status --porcelain; fail "the repo has awb files"; }

echo "PASS"
