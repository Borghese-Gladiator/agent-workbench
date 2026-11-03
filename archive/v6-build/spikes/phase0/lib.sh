#!/usr/bin/env bash
set -euo pipefail

GAMES_REPO="${GAMES_REPO:-$HOME/GitHub/wip-browser-games}"
PW_VERSION="${PW_VERSION:-1.61.1}"

scratch_games() {
  local dest="$1"
  git clone -q "$GAMES_REPO" "$dest"
  cp -cR "$GAMES_REPO/node_modules" "$dest/node_modules"
}

assert_clean() {
  local repo="$1" out
  out="$(git -C "$repo" status --porcelain)"
  if [ -n "$out" ]; then
    echo "git status in $repo is NOT clean:"
    echo "$out"
    return 1
  fi
  echo "git status in $repo is clean"
}
