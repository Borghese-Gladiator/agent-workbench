#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <github-pr-url> [output-dir]" >&2
  exit 1
fi

PR_URL="$1"
OUTDIR="${2:-pr_context}"

python3 - "$PR_URL" "$OUTDIR" <<'PY'
import json
import os
import re
import subprocess
import sys
from pathlib import Path

pr_url = sys.argv[1]
outdir = Path(sys.argv[2]).resolve()
outdir.mkdir(parents=True, exist_ok=True)

m = re.match(r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:/.*)?$", pr_url)
if not m:
    raise SystemExit("Invalid GitHub PR URL. Expected format: https://github.com/<owner>/<repo>/pull/<number>")
owner, repo, number = m.groups()
repo_slug = f"{owner}/{repo}"
base = f"repos/{repo_slug}/pulls/{number}"
issue_base = f"repos/{repo_slug}/issues/{number}"

def gh_json(path):
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        err = result.stderr.strip() or result.stdout.strip() or f"gh api failed for {path}"
        raise SystemExit(err)
    return json.loads(result.stdout)

pr = gh_json(base)
files = gh_json(base + "/files")
review_comments = gh_json(base + "/comments")
issue_comments = gh_json(issue_base + "/comments")
reviews = gh_json(base + "/reviews")

(outdir / "pr.json").write_text(json.dumps(pr, indent=2))
(outdir / "files.json").write_text(json.dumps(files, indent=2))
(outdir / "review_comments.json").write_text(json.dumps(review_comments, indent=2))
(outdir / "issue_comments.json").write_text(json.dumps(issue_comments, indent=2))
(outdir / "reviews.json").write_text(json.dumps(reviews, indent=2))

lines = []
lines.append(f"# PR context for {repo_slug}#{number}")
lines.append("")
lines.append("## Pull request")
lines.append(f"- Title: {pr.get('title','')}")
lines.append(f"- State: {pr.get('state','')}")
lines.append(f"- Author: {(pr.get('user') or {}).get('login','')}")
lines.append(f"- Base: {(pr.get('base') or {}).get('ref','')}")
lines.append(f"- Head: {(pr.get('head') or {}).get('ref','')}")
lines.append("")
body = pr.get('body') or ''
if body:
    lines.append("### Body")
    lines.append(body)
    lines.append("")
lines.append("## Files")
for f in files:
    lines.append(f"- {f.get('filename','')} ({f.get('status','')} +{f.get('additions',0)} -{f.get('deletions',0)})")
    patch = f.get('patch')
    if patch:
        lines.append("```diff")
        lines.append(patch[:12000])
        lines.append("```")
lines.append("")
lines.append("## Review comments")
if review_comments:
    for c in review_comments:
        user = (c.get('user') or {}).get('login','unknown')
        path = c.get('path','')
        line = c.get('line') or c.get('original_line') or ''
        body = c.get('body') or ''
        lines.append(f"- {user} on {path}:{line} — {body}")
else:
    lines.append("- none")
lines.append("")
lines.append("## Issue comments")
if issue_comments:
    for c in issue_comments:
        user = (c.get('user') or {}).get('login','unknown')
        body = c.get('body') or ''
        lines.append(f"- {user} — {body}")
else:
    lines.append("- none")
lines.append("")
lines.append("## Reviews")
if reviews:
    for r in reviews:
        user = (r.get('user') or {}).get('login','unknown')
        state = r.get('state') or ''
        body = (r.get('body') or '').strip()
        lines.append(f"- {user} [{state}]")
        if body:
            lines.append(f"  - {body}")
else:
    lines.append("- none")

(outdir / "combined_comments.md").write_text("\n".join(lines) + "\n")
print(str(outdir))
PY
