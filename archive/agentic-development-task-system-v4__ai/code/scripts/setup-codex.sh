#!/usr/bin/env bash
set -euo pipefail

if command -v codex >/dev/null 2>&1; then
  echo "codex present: $(command -v codex)"
elif command -v brew >/dev/null 2>&1; then
  if brew list --cask codex >/dev/null 2>&1; then
    echo "brew cask present but binary missing (quarantined?) — reinstalling"
    brew reinstall --cask codex
  else
    brew install codex
  fi
elif command -v npm >/dev/null 2>&1; then
  npm install -g @openai/codex
else
  echo "error: need homebrew or npm to install codex" >&2
  exit 1
fi

hash -r 2>/dev/null || true

echo "--- version ---"
codex --version

echo "--- auth ---"
if codex login status; then
  echo "auth OK"
else
  echo "not logged in — run interactively: codex login"
fi
