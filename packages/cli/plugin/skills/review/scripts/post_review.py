#!/usr/bin/env python3
"""Submit a single PR review (summary body + batched inline comments) via the GitHub API.

Reads a JSON payload describing the review and posts it with
`gh api repos/{owner}/{repo}/pulls/{number}/reviews`. Inline comments are
attached to the review so they land as one cohesive review, not N drive-by notes.

Payload shape (read from --payload file, or stdin):
{
  "pr_url": "https://github.com/owner/repo/pull/123",
  "event": "COMMENT",            # COMMENT | REQUEST_CHANGES | APPROVE
  "body": "## AI collab review\n...summary markdown...",
  "comments": [
    {
      "path": "path/to/file.tsx",
      "line": 73,                # end line of the target range (required)
      "start_line": 65,          # optional, for multi-line ranges
      "side": "RIGHT",           # RIGHT (new) | LEFT (old); default RIGHT
      "start_side": "RIGHT",     # optional
      "body": "**CLAUDE says:** ...\n<details>...</details>"
    }
  ]
}

Notes:
- `line`/`start_line` are file line numbers at the review commit — they must fall
  on lines present in the PR diff or GitHub rejects the comment.
- Omit `line` entirely for a file-level comment (uses `subject_type: file`).
- Exits non-zero and prints gh's stderr on failure so the caller can react.
"""
import json
import subprocess
import sys
from argparse import ArgumentParser


def parse_pr_url(url: str):
    import re

    m = re.match(r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if not m:
        raise SystemExit(f"Invalid PR URL: {url}")
    return m.group(1), m.group(2), m.group(3)


def build_comment(c: dict) -> dict:
    out = {"path": c["path"], "body": c["body"]}
    if c.get("line") is None:
        # File-level comment (no line anchor).
        out["subject_type"] = "file"
        return out
    out["line"] = c["line"]
    out["side"] = c.get("side", "RIGHT")
    if c.get("start_line") is not None:
        out["start_line"] = c["start_line"]
        out["start_side"] = c.get("start_side", out["side"])
    return out


def main():
    ap = ArgumentParser()
    ap.add_argument("--payload", help="Path to JSON payload file; stdin if omitted")
    ap.add_argument("--dry-run", action="store_true", help="Print the API request, do not post")
    args = ap.parse_args()

    raw = open(args.payload).read() if args.payload else sys.stdin.read()
    payload = json.loads(raw)

    owner, repo, number = parse_pr_url(payload["pr_url"])
    api_path = f"repos/{owner}/{repo}/pulls/{number}/reviews"

    body = {
        "event": payload.get("event", "COMMENT"),
        "body": payload.get("body", ""),
    }
    comments = [build_comment(c) for c in payload.get("comments", [])]
    if comments:
        body["comments"] = comments

    if args.dry_run:
        print(f"POST {api_path}")
        print(json.dumps(body, indent=2))
        return

    proc = subprocess.run(
        ["gh", "api", "--method", "POST", api_path, "--input", "-"],
        input=json.dumps(body),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(proc.returncode)

    resp = json.loads(proc.stdout)
    print(f"Review posted: {resp.get('html_url', '(no url)')}")
    print(f"State: {resp.get('state')}  Inline comments: {len(comments)}")


if __name__ == "__main__":
    main()
