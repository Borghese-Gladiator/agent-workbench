#!/usr/bin/env bash
# Check 2: do hook payloads hold token counts? If not, does the transcript they name?
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

WORK="${WORK:-$(mktemp -d)}"
REPO="$WORK/games"
LOG="$WORK/hooks.jsonl"
echo "work dir: $WORK"

git clone -q "$GAMES_REPO" "$REPO"
assert_clean "$REPO"

cat > "$WORK/hook.sh" <<EOF
#!/bin/sh
cat >> "$LOG"
echo >> "$LOG"
EOF
chmod +x "$WORK/hook.sh"

node -e '
const cmd = process.argv[1];
const h = [{ hooks: [{ type: "command", command: cmd }] }];
const hm = [{ matcher: "*", hooks: [{ type: "command", command: cmd }] }];
console.log(JSON.stringify({ hooks: {
  SessionStart: h, UserPromptSubmit: h, PreToolUse: hm, PostToolUse: hm, Stop: h, SessionEnd: h,
} }));
' "$WORK/hook.sh" > "$WORK/settings.json"

(cd "$REPO" && echo "Run the shell command: ls games. Then reply with the number of entries." \
  | claude -p --settings "$WORK/settings.json" --allowedTools "Bash(ls:*)" > "$WORK/out.txt")
cat "$WORK/out.txt"
assert_clean "$REPO"

node - "$LOG" <<'JS'
const fs = require("fs");
const events = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const seen = [...new Set(events.map((e) => e.hook_event_name))];
console.log("hook events:", seen.join(", "));
const missing = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"].filter((n) => !seen.includes(n));
if (missing.length) console.log("missing hook events:", missing.join(", "));

const tokenKey = /token|usage/i;
const found = new Set();
const scan = (o, path) => {
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
    if (tokenKey.test(k)) found.add(path + k);
    scan(v, path + k + ".");
  }
};
for (const e of events) scan(e, e.hook_event_name + ":");
if (found.size) {
  console.log("PASS: tokens in hook payloads:", [...found].join(", "));
  process.exit(0);
}
console.log("no token or usage fields in hook payloads");
console.log("payload keys:", [...new Set(events.flatMap((e) => Object.keys(e)))].join(", "));

const tp = events.find((e) => e.transcript_path)?.transcript_path;
if (!tp || !fs.existsSync(tp)) { console.log("FAIL: no transcript_path, or the file is missing:", tp); process.exit(1); }
console.log("transcript_path:", tp);
const rows = fs.readFileSync(tp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const usage = rows.filter((r) => r.message?.usage).map((r) => ({ id: r.message.id, u: r.message.usage }));
if (!usage.length) { console.log("FAIL: transcript has no message.usage"); process.exit(1); }
const byId = new Map(usage.map((x) => [x.id, x.u]));
const sum = {};
for (const u of byId.values()) for (const [k, v] of Object.entries(u)) if (typeof v === "number") sum[k] = (sum[k] ?? 0) + v;
console.log("usage field names:", Object.keys(usage[0].u).join(", "));
console.log(`assistant rows with usage: ${usage.length}, unique message ids: ${byId.size}`);
console.log("session totals (dedup by message.id):", JSON.stringify(sum));
console.log("PASS: tokens come from the transcript file named by transcript_path (field: message.usage)");
JS
