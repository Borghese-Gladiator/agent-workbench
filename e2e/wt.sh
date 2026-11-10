#!/usr/bin/env bash
# End-to-end test for `awb wt`: the real bin/awb, real git worktrees, and the picker in a pseudo-terminal.
# Usage: bash e2e/wt.sh   (no network, no claude, no cost)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWB="$HERE/../packages/cli/bin/awb"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export AWB_HOME="$T/home" AWB_WORKTREES="$T/wt" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok   $*"; }

for r in alpha beta; do
  git init -q -b main "$T/$r"
  git -C "$T/$r" commit -q --allow-empty -m init
done
git -C "$T/alpha" worktree add -q -b feat/one "$AWB_WORKTREES/alpha/feat-one"
git -C "$T/alpha" worktree add -q -b feat/two "$AWB_WORKTREES/alpha/feat-two"
git -C "$T/beta" worktree add -q -b fix/x "$AWB_WORKTREES/beta/fix-x"
touch "$AWB_WORKTREES/alpha/feat-two/dirty.txt"
mkdir -p "$AWB_WORKTREES/beta/leftover"

out="$("$AWB" wt 2>/dev/null)"
grep -q "^alpha (2)$" <<<"$out" || fail "alpha group: $out"
grep -q "^beta (2)$" <<<"$out" || fail "beta group: $out"
grep -q "feat/two .*1 changed" <<<"$out" || fail "dirty count: $out"
grep -q "leftover .*not a worktree" <<<"$out" || fail "plain folder: $out"
ok "list groups by repo, shows branch, changes and plain folders"

[ "$("$AWB" wt beta 2>/dev/null | grep -c '^\S')" = 2 ] || fail "repo filter"
ok "repo filter"

"$AWB" wt --json 2>/dev/null | tee "$T/wt.json" | node -e 'const l=JSON.parse(require("fs").readFileSync(0));if(l.length!==4||l.find(w=>w.name==="feat-one").branch!=="feat/one")process.exit(1)' || fail "json: $(cat "$T/wt.json")"
ok "--json"

"$AWB" wt --root "$T/nope" >/dev/null 2>&1 && fail "missing root should exit 1"
ok "missing root exits 1"

# keys reach the picker after it enters raw mode; the delays give it time to start
keys() { perl -e 'select(undef,undef,undef,1.5); for (@ARGV) { print eval "\"$_\""; select(undef,undef,undef,0.3) } select(undef,undef,undef,1)' "$@"; }
pty() { script -q /dev/null "$AWB" "$@" 2>/dev/null | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

path="$(keys 'j' '\r' | pty wt pick alpha | grep -o "$AWB_WORKTREES/[^ ]*" | tail -1)"
[ "$path" = "$AWB_WORKTREES/alpha/feat-two" ] || fail "pick path: '$path'"
ok "pick: down + enter prints the second path"

keys ' ' 'd' 'y' 'q' | pty wt pick alpha >/dev/null || true
[ -d "$AWB_WORKTREES/alpha/feat-one" ] && fail "clean worktree not removed"
git -C "$T/alpha" worktree list | grep -q feat-one && fail "git still lists feat-one"
ok "pick: space, d, y removes a clean worktree"

keys ' ' 'd' 'y' 'q' | pty wt pick alpha >/dev/null || true
[ -d "$AWB_WORKTREES/alpha/feat-two" ] || fail "dirty worktree was removed"
ok "pick: a dirty worktree is kept"

echo "all e2e checks passed"
