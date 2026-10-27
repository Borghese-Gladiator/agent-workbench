#!/usr/bin/env bash
#
# check-pr.sh <run_dir>
#
# Snapshot the PR's current state via `gh pr view --json` and append a
# timestamped entry to runs/<run_id>/run-log.md.
#
# This script intentionally does NOT change run status — the human/agent driving
# the CI-fix loop decides when to flip status (typically back to in_progress
# after pushing a fix, or to qa once checks are green).
#
# We use Python (stdlib json) to format the gh output rather than jq, to keep
# zero-dep with the rest of the workbench.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

usage() { echo "usage: check-pr.sh <run_dir>" >&2; exit 2; }
[[ $# -eq 1 ]] || usage

RUN_DIR_INPUT="$1"
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 \
  || fail "gh (GitHub CLI) is not installed. Install it from https://cli.github.com/ and run 'gh auth login'."

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is installed but not authenticated. Run: gh auth login"
fi

RUN_DIR="$(cd "${RUN_DIR_INPUT}" 2>/dev/null && pwd)" \
  || fail "run directory does not exist: ${RUN_DIR_INPUT}"

[[ -f "${RUN_DIR}/metadata.yaml" ]] || fail "metadata.yaml missing in ${RUN_DIR}"
[[ -f "${RUN_DIR}/run-log.md" ]]    || fail "run-log.md missing in ${RUN_DIR}"

META_RAW="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" <<'PY'
import sys
from pathlib import Path
from lib.metadata import load, MetadataError
try:
    md = load(Path(sys.argv[1]))
except MetadataError as exc:
    print(f"ERR:{exc}", file=sys.stderr)
    sys.exit(1)
if not md.pr_url:
    print("ERR:no pr_url in metadata. Run scripts/open-pr.sh first.", file=sys.stderr)
    sys.exit(1)
print(f"{md.run_id}|{md.github_repo}|{md.pr_url}|{md.pr_number}")
PY
)" || fail "failed to load metadata"

IFS='|' read -r RUN_ID GITHUB_REPO PR_URL PR_NUMBER <<<"${META_RAW}"

# --- Fetch PR snapshot --------------------------------------------------------

GH_FIELDS="state,mergeable,isDraft,statusCheckRollup,reviews,reviewDecision,comments,headRefName,baseRefName,url"

GH_JSON="$(
  gh pr view "${PR_NUMBER}" \
    --repo "${GITHUB_REPO}" \
    --json "${GH_FIELDS}" \
    2>&1
)" || {
  printf 'gh error:\n%s\n' "${GH_JSON}" >&2
  fail "gh pr view failed (see message above). The PR may have been closed or the auth token may lack access."
}

# --- Format the snapshot ------------------------------------------------------

SUMMARY="$(
  python3 - <<'PY' "${GH_JSON}"
import json
import sys

raw = sys.argv[1]
try:
    pr = json.loads(raw)
except json.JSONDecodeError as exc:
    print(f"(could not parse gh output as JSON: {exc})")
    sys.exit(0)

lines = []
lines.append(f"**PR state:** {pr.get('state', '?')} "
             f"(draft={pr.get('isDraft', '?')}, "
             f"mergeable={pr.get('mergeable', '?')}, "
             f"review_decision={pr.get('reviewDecision') or 'none'})")
lines.append(f"**Branches:** {pr.get('headRefName', '?')} → {pr.get('baseRefName', '?')}")

# ----- Checks ---------------------------------------------------------------
checks = pr.get("statusCheckRollup") or []
if not checks:
    lines.append("**Checks:** (none reported)")
else:
    counts = {"SUCCESS": 0, "FAILURE": 0, "PENDING": 0, "OTHER": 0}
    failing = []
    pending = []
    for c in checks:
        # gh's statusCheckRollup mixes two shapes:
        #   - CheckRun:        completed → 'conclusion'; in-flight → 'status'
        #   - StatusContext:   single field 'state'
        # Take whichever is non-empty; 'conclusion' wins when both are present
        # (a completed check-run reports both status=COMPLETED and a conclusion).
        status_field = (c.get("conclusion") or c.get("status") or c.get("state") or "").upper()
        name = c.get("name") or c.get("context") or "(unnamed)"
        if status_field in ("SUCCESS", "NEUTRAL", "SKIPPED"):
            counts["SUCCESS"] += 1
        elif status_field in ("FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"):
            counts["FAILURE"] += 1
            failing.append((name, status_field, c.get("detailsUrl") or c.get("targetUrl") or ""))
        elif status_field in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"):
            counts["PENDING"] += 1
            pending.append((name, status_field))
        else:
            counts["OTHER"] += 1
    lines.append(
        "**Checks:** "
        f"success={counts['SUCCESS']}, "
        f"failure={counts['FAILURE']}, "
        f"pending={counts['PENDING']}, "
        f"other={counts['OTHER']}"
    )
    if failing:
        lines.append("  Failing:")
        for name, st, url in failing:
            suffix = f"  ({url})" if url else ""
            lines.append(f"  - {name}: {st}{suffix}")
    if pending:
        lines.append("  Pending:")
        for name, st in pending:
            lines.append(f"  - {name}: {st}")

# ----- Reviews / comments ---------------------------------------------------
reviews = pr.get("reviews") or []
if reviews:
    by_state = {}
    for r in reviews:
        state = r.get("state") or "UNKNOWN"
        by_state[state] = by_state.get(state, 0) + 1
    lines.append("**Reviews:** " + ", ".join(f"{k.lower()}={v}" for k, v in sorted(by_state.items())))
    # Surface the most recent comment per state for quick glance.
    latest_comments = []
    for r in reviews[-5:]:
        body = (r.get("body") or "").strip().splitlines()
        if not body:
            continue
        author = (r.get("author") or {}).get("login", "?")
        latest_comments.append(f"  - @{author} ({r.get('state', '?')}): {body[0][:120]}")
    if latest_comments:
        lines.append("  Recent review notes:")
        lines.extend(latest_comments)
else:
    lines.append("**Reviews:** none yet")

issue_comments = pr.get("comments") or []
unresolved = [c for c in issue_comments if not c.get("isResolved", False)]
if unresolved:
    lines.append(f"**Unresolved comments:** {len(unresolved)}")
    for c in unresolved[-5:]:
        body = (c.get("body") or "").strip().splitlines()
        if not body:
            continue
        author = (c.get("author") or {}).get("login", "?")
        lines.append(f"  - @{author}: {body[0][:120]}")

print("\n".join(lines))
PY
)"

# --- Append to run-log.md -----------------------------------------------------

TS="$(date -u +%Y-%m-%dT%H:%MZ)"
{
  printf '\n## %s — PR check (%s)\n' "${TS}" "${PR_URL}"
  printf '%s\n' "${SUMMARY}"
} >> "${RUN_DIR}/run-log.md"

# Echo to stdout too so the user/agent can react immediately.
cat <<EOF
checked PR: ${PR_URL}
appended summary to ${RUN_DIR}/run-log.md

----------------------------------------------------------------------
${SUMMARY}
----------------------------------------------------------------------
EOF
