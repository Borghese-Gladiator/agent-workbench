#!/usr/bin/env bash
#
# audit-docs.sh — prove the agent-facing docs don't lie about the repo.
#
# Checks that the structural claims in AGENTS.md / README.md resolve against the
# real filesystem. This is what makes "the docs are good for agents" a testable
# property instead of an assertion: an agent following a dead path in AGENTS.md
# burns a turn and improvises, so a broken path is a real defect.
#
# Exit code 0 = every claim holds; nonzero = drift found (safe for CI / hooks).
#
# Usage:  scripts/audit-docs.sh   (run from anywhere; resolves the repo root)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

fail=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '  \xe2\x9c\x97 %s\n' "$1"; fail=1; }

echo "== 1. Agent entrypoint files exist at root =="
for f in CLAUDE.md AGENTS.md README.md; do
  if [ -f "$f" ]; then note "ok  $f"; else bad "missing $f"; fi
done

echo
echo "== 2. Every path AGENTS.md points at resolves on disk =="
# Backtick-quoted `apps/…`, `packages/…`, etc. path claims, resolved by prefix
# so `docs/design` matches `docs/design.md`. Loop reads from a process
# substitution (not a pipe) so `bad` mutates the top-level `fail`.
while read -r p; do
  if compgen -G "${p}*" > /dev/null; then note "ok  $p"; else bad "broken path: $p"; fi
done < <(grep -oE '`(apps|packages|workers|docs|scripts|archive)/[a-z0-9_-]*`?' AGENTS.md | tr -d '`' | sort -u)

echo
echo "== 3. AGENTS.md claims every packages/* has its own README.md =="
if grep -qF 'Every package under `packages/` has its own `README.md`' AGENTS.md; then
  miss=0
  for d in packages/*/; do
    if [ ! -f "${d}README.md" ]; then bad "no README.md in $d (contradicts AGENTS.md claim)"; miss=1; fi
  done
  [ "$miss" -eq 0 ] && note "ok  all packages/* have a README.md"
else
  note "skip (AGENTS.md no longer makes the 'every package' claim)"
fi

echo
echo "== 4. README.md 'Layout' block: no claimed-but-absent top-level dirs =="
# Any `word/` token that starts a line in the fenced Layout block must be a real
# path. Section runs from '## Layout' to the next '## ' heading.
while read -r p; do
  if [ -e "$p" ]; then note "ok  $p"; else bad "Layout lists absent path: $p"; fi
done < <(sed -n '/^## Layout/,/^## [A-Z]/p' README.md | grep -oE '^[a-z][a-z0-9/_-]*/' | sort -u)

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS - docs match the filesystem."
else
  echo "FAIL - docs drift from the filesystem (see marks above)."
fi
exit "$fail"
