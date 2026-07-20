#!/usr/bin/env bash
# Render a single PR's metadata + comments + reviews into a readable markdown file.
# Usage: render_pr.sh <stem>   where stem is like "app_116708"
set -euo pipefail
stem="$1"
cd "$(dirname "$0")"

meta="${stem}.metadata.json"
issue="${stem}.issue_comments.json"
review="${stem}.review_comments.json"
reviews="${stem}.reviews.json"
out="${stem}.comments.md"

{
  echo "# PR Summary: $stem"
  echo
  jq -r '"- **Title**: \(.title)\n- **Author**: \(.author.login)\n- **State**: \(.state)\n- **URL**: \(.url)\n- **Created**: \(.createdAt)\n- **Closed**: \(.closedAt // "n/a")\n- **Merged**: \(.mergedAt // "n/a")\n- **Files changed**: \(.changedFiles)  (+\(.additions) / -\(.deletions))\n- **Review decision**: \(.reviewDecision // "n/a")\n- **Labels**: \([.labels[].name] | join(", "))"' "$meta"
  echo
  echo "## PR Description"
  echo
  jq -r '.body // "(empty)"' "$meta"
  echo
  echo "---"
  echo
  echo "## Reviews (top-level review submissions)"
  echo
  if [ "$(jq 'length' "$reviews")" -gt 0 ]; then
    jq -r '.[] | "### Review by @\(.user.login) — \(.state) — \(.submitted_at)\n\n\(.body // "(no body)")\n"' "$reviews"
  else
    echo "(no reviews)"
    echo
  fi
  echo "---"
  echo
  echo "## Inline Review Comments (on diff)"
  echo
  if [ "$(jq 'length' "$review")" -gt 0 ]; then
    jq -r '.[] | "### @\(.user.login) on `\(.path):\(.line // .original_line // "?")` — \(.created_at)\n\n```diff\n\(.diff_hunk // "")\n```\n\n\(.body)\n"' "$review"
  else
    echo "(no inline review comments)"
    echo
  fi
  echo "---"
  echo
  echo "## Issue-Level Comments (PR conversation)"
  echo
  if [ "$(jq 'length' "$issue")" -gt 0 ]; then
    jq -r '.[] | "### @\(.user.login) — \(.created_at)\n\n\(.body)\n"' "$issue"
  else
    echo "(no issue-level comments)"
    echo
  fi
} > "$out"
echo "wrote $out"
