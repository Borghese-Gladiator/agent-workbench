#!/usr/bin/env bash
#
# init-repo.sh — bootstrap an ai-workbench checkout.
#
# Idempotent: safe to re-run. Creates missing directories, initializes git if
# needed, copies repos.yaml.example → repos.yaml when the latter is absent,
# and runs validate-workbench.sh at the end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

log() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Tooling preflight ---------------------------------------------------------

command -v git >/dev/null 2>&1 || fail "git is required but not on PATH."
command -v python3 >/dev/null 2>&1 || fail "python3 is required but not on PATH."

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
log "python3 detected: ${PY_VERSION}"

# --- Directory skeleton --------------------------------------------------------

# Match the structure documented in README.md. mkdir -p is idempotent.
DIRS=(
  "config"
  "docs"
  "ideas/raw"
  "ideas/normalized"
  "runs"
  "worktrees"
  "templates"
  "scripts"
  "lib"
)

for dir in "${DIRS[@]}"; do
  mkdir -p "${dir}"
done

# Drop .gitkeep into directories that should exist in a fresh clone but are
# allowed to be empty.
for dir in "ideas/raw" "ideas/normalized" "runs" "worktrees"; do
  if [[ -z "$(ls -A "${dir}" 2>/dev/null)" ]]; then
    : > "${dir}/.gitkeep"
  fi
done

# --- Git init ------------------------------------------------------------------
#
# Detect "already a git checkout" via `git rev-parse`, which correctly handles:
#   - regular repos (.git is a directory)
#   - worktrees     (.git is a file pointing at the parent's worktrees/ dir)
#   - subdirs of    (no .git here, but rev-parse walks upward and finds it)
#     either of the above
#
# A naive `[[ ! -d .git ]]` check would call `git init` inside an existing
# worktree subdirectory, clobbering the worktree relationship.

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "git already tracking $(git rev-parse --show-toplevel); skipping git init"
else
  log "initializing git repository"
  git init -q
fi

# --- Config bootstrap ----------------------------------------------------------

if [[ ! -f "config/repos.yaml" ]]; then
  if [[ -f "config/repos.yaml.example" ]]; then
    cp "config/repos.yaml.example" "config/repos.yaml"
    log "copied config/repos.yaml.example → config/repos.yaml"
  else
    log "warning: config/repos.yaml.example not found; skipping config bootstrap"
  fi
else
  log "config/repos.yaml already present; leaving untouched"
fi

# --- Beads init (optional) -----------------------------------------------------

if command -v bd >/dev/null 2>&1; then
  # `bd info` walks up to find an existing .beads/ — works for worktrees too.
  if bd info >/dev/null 2>&1; then
    log "beads already initialized; skipping bd init"
  else
    log "initializing beads"
    bd init --non-interactive --prefix wb >/dev/null || \
      log "warning: bd init failed; Beads sync will be unavailable"
  fi
else
  log "bd not on PATH; skipping Beads init (Beads is optional)"
fi

# --- Validate ------------------------------------------------------------------

log ""
log "running validate-workbench.sh..."
"${SCRIPT_DIR}/validate-workbench.sh" || fail "workbench validation failed"

# --- Next steps ----------------------------------------------------------------

cat <<'EOF'

ai-workbench initialized.

Next steps:
  1. Edit config/repos.yaml to register your product repos (absolute paths only).
  2. ./scripts/validate-workbench.sh    # re-run after editing config
  3. ./scripts/new-feature.sh <repo_key> <feature-slug> "rough idea text"
  4. (edit the run's spec.md, then flip status to "planned" in metadata.yaml)
  5. ./scripts/create-worktree.sh runs/<run_id>

EOF
