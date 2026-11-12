#!/usr/bin/env bash
# End-to-end check of the web UI, with a stub claude and a stub gh (no tokens, no GitHub).
# The real daemon, runner, awb CLI, hooks, git worktrees, gate and Playwright proof runs do the work.
# The stack: Scoreboard ships a draft PR. Footer fails at the gate (the app has no footer). Broken waits.
# Then e2e/ui.spec.ts drives the UI in a browser: run view, cost, quiet and lost, logs, PRs,
# Rewrite test and Retry on Footer (the retry ships it, then Broken fails) and Drop on Broken.
# Usage: bash e2e/ui.sh   (WORK=<dir> keeps the files; it takes about 2 min)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AWB="$ROOT/packages/cli/bin/awb"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
export AWB_HOME="$WORK/home" AWB_SYNC_MS=3600000 AWB_QUIET_MIN=1 AWB_TASK_TIMEOUT_MIN=5 AWB_NOTIFY_CMD=true
export AWB_E2E_WORK="$WORK" AWB_E2E_HOOK="$ROOT/packages/cli/bin/awb-hook"
echo "work dir: $WORK"
trap '"$AWB" daemon stop >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL: $1"; exit 1; }
j() { node -e "const v=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log($1)"; }
G() { git -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t "$@"; }

echo "== 1. a repo with a static app and an origin"
REPO="$WORK/repo"
git init -q --bare "$WORK/origin.git"
mkdir -p "$REPO/.awb"
git -C "$REPO" init -q -b main
cat > "$REPO/.awb/run.md" <<'EOF'
## setup
```sh
echo "setup: nothing to install"
```

## start
```sh
python3 -m http.server {port}
```
url: http://localhost:{port}
ready: /
EOF
echo '<!doctype html><title>demo</title><h1>Demo</h1>' > "$REPO/index.html"
G -C "$REPO" add .
G -C "$REPO" commit -q -m "demo app"
git -C "$REPO" remote add origin "$WORK/origin.git"
git -C "$REPO" push -q -u origin main
git -C "$REPO" remote set-head origin main

echo "== 2. stub claude and stub gh"
mkdir -p "$WORK/bin"
ln -sf "$AWB" "$WORK/bin/awb"
cat > "$WORK/bin/claude" <<'EOF'
#!/usr/bin/env bash
# Stub claude.
# As the test writer (--agents): write one Playwright test for each claim in claims.md.
# As a task session (under awb): do the work of the task, then run the real awb prove and awb ship.
prompt=$(cat)
if [[ " $* " == *" --agents "* ]]; then
  mkdir -p proof-tests
  for id in $(grep -o '^- C[0-9]*' claims.md | cut -c3-); do
    case "$id" in
      C1) expect='await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();' ;;
      C2) expect='await expect(page.getByRole("contentinfo")).toHaveText("Footer", { timeout: 2000 });' ;;
      *) expect='await expect(page.getByRole("button", { name: "Missing" })).toBeVisible({ timeout: 2000 });' ;;
    esac
    printf 'import { test, expect } from "@playwright/test";\ntest("%s: the claim", async ({ page }) => {\n  await page.goto("/");\n  %s\n});\n' "$id" "$expect" > "proof-tests/$(echo "$id" | tr A-Z a-z).spec.ts"
  done
  echo '{"type":"result","subtype":"success","num_turns":3,"total_cost_usd":0.75}'
  exit 0
fi
t=$(mktemp)
echo '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":100000,"output_tokens":10000}}}' > "$t"
hook() { printf '{"hook_event_name":"%s","tool_name":"Bash","transcript_path":"%s"}' "$1" "$t" | "$AWB_E2E_HOOK"; }
hook PreToolUse
commit() { git -c core.hooksPath=/dev/null -c user.email=a@b -c user.name=t commit -qam "$1"; }
if [[ "$prompt" == *'stack: "Scoreboard"'* ]]; then echo '<p id="score">0</p>' >> index.html; commit scoreboard; fi
if [[ "$prompt" == *'stack: "Footer"'* && -f "$AWB_E2E_WORK/fix-footer" ]]; then echo '<footer>Footer</footer>' >> index.html; commit footer; fi
awb prove >&2
awb ship >&2
hook Stop
echo '{"type":"result","subtype":"success","num_turns":4,"total_cost_usd":0.6,"usage":{"input_tokens":100000,"output_tokens":10000}}'
EOF
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env node
// Stub gh: draft PRs and release assets kept in a JSON file. Every PR is OPEN.
const fs = require("fs");
const path = require("path");
const w = process.env.AWB_E2E_WORK;
const file = path.join(w, "gh.json");
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { prs: {}, assets: {} };
const a = process.argv.slice(2);
fs.appendFileSync(path.join(w, "gh-calls.txt"), a.join(" ") + "\n");
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const url = (n) => `https://github.com/example/demo/pull/${n}`;
switch (a[0] + " " + a[1]) {
  case "pr create": {
    const n = Object.keys(s.prs).length + 1;
    s.prs[a[a.indexOf("--head") + 1]] = n;
    save();
    console.log(url(n));
    break;
  }
  case "pr view": {
    const x = a[2];
    const n = /^\d+$/.test(x) ? Number(x) : x.includes("/pull/") ? Number(x.split("/pull/")[1]) : s.prs[x];
    if (!n) process.exit(1);
    console.log(JSON.stringify({ number: n, url: url(n), state: "OPEN" }));
    break;
  }
  case "release view":
    if (!s.assets[a[2]]) process.exit(1);
    console.log(JSON.stringify({ assets: s.assets[a[2]].map((n) => ({ name: n, url: "https://example.com/" + n })) }));
    break;
  case "release create":
    s.assets[a[2]] = [];
    save();
    break;
  case "release upload":
    s.assets[a[2]].push(...a.slice(3).filter((x) => x !== "--clobber").map((f) => path.basename(f)));
    save();
    break;
}
EOF
chmod +x "$WORK/bin/claude" "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

echo "== 3. a stack of three tasks, run by the real runner"
STACK='{"tasks":[
 {"title":"Scoreboard","claims":[{"id":"C1","text":"The page shows the Demo heading."}]},
 {"title":"Footer","claims":[{"id":"C1","text":"The page shows the Demo heading."},{"id":"C2","text":"The page shows a footer."}]},
 {"title":"Broken","claims":[{"id":"C1","text":"The page shows the Demo heading."},{"id":"C3","text":"The page shows a Missing button."}]}
]}'
(cd "$REPO" && echo "$STACK" | awb stack set --json 2>/dev/null) > "$WORK/stack.json"
T1=$(j 'v.stack.tasks[0].id' < "$WORK/stack.json")
T2=$(j 'v.stack.tasks[1].id' < "$WORK/stack.json")
T3=$(j 'v.stack.tasks[2].id' < "$WORK/stack.json")
(cd "$REPO" && awb run --wait --json 2>/dev/null) > "$WORK/run.json" && fail "the run did not stop at the Footer task" || true
cat "$WORK/run.json"
[ "$(j 'v.state' < "$WORK/run.json")" = stopped ] || fail "the run is not stopped"
grep -q "C2" "$WORK/run.json" || fail "the stop reason does not name C2"
(cd "$REPO" && awb show "$T1" --json 2>/dev/null) | j 'v.status+" "+v.pr_number' | grep -qx "done 1" || fail "Scoreboard has no PR"
(cd "$REPO" && awb show "$T2" --json 2>/dev/null) | j 'v.status' | grep -qx failed || fail "Footer did not fail"
(cd "$REPO" && awb show "$T3" --json 2>/dev/null) | j 'v.status' | grep -qx waiting || fail "Broken is not waiting"

echo "== 4. a quiet session and a lost session"
PORT=$(j 'v.port' < "$AWB_HOME/daemon.json")
API="http://127.0.0.1:$PORT"
post() { curl -sf -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }
post /api/sessions "{\"repo\":\"$REPO\",\"worktree\":\"$REPO\",\"branch\":\"lost-branch\",\"pid\":999999}" > /dev/null
QUIET=$(post /api/sessions "{\"repo\":\"$REPO\",\"worktree\":\"$REPO\",\"branch\":\"quiet-branch\",\"pid\":$$}" | j 'v.id')
post /api/events "{\"awb_session_id\":\"$QUIET\",\"payload\":{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Read\"}}" > /dev/null
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
new DatabaseSync(process.argv[1]).prepare("UPDATE events SET at = ? WHERE session_id = ?").run(new Date(Date.now() - 5 * 60000).toISOString(), process.argv[2]);
' "$AWB_HOME/awb.db" "$QUIET"

echo "== 5. the browser test of the UI"
cd "$ROOT"
AWB_URL="$API" AWB_T1="$T1" AWB_T2="$T2" AWB_T3="$T3" node_modules/.bin/playwright test --config e2e/ui.config.ts
echo
echo "screenshots: $WORK/screens"
echo "PASS"
