#!/usr/bin/env bash
#
# validate-workbench.sh
#
# Sanity check the ai-workbench installation. Exits 0 on success, 1 on failure.
# Intended to be run after init-repo.sh and again whenever config changes.
#
# Checks:
#   - python3 + git on PATH
#   - required directories present
#   - all expected templates present
#   - lib/ Python helpers importable
#   - config/repos.yaml parses (if present)
#   - configured repo paths exist and look like git repos
#   - every existing run's metadata.yaml parses

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

errors=0
warnings=0

note()  { printf '  %s\n' "$*"; }
ok()    { printf '  ok  %s\n' "$*"; }
warn()  { printf '  warn %s\n' "$*" >&2; warnings=$((warnings + 1)); }
fail() { printf '  fail %s\n' "$*" >&2; errors=$((errors + 1)); }

echo "validating ai-workbench at ${WORKBENCH_ROOT}"

# --- Tooling ------------------------------------------------------------------

echo
echo "[tooling]"
if command -v git >/dev/null 2>&1; then ok "git: $(git --version)"; else fail "git not on PATH"; fi
if command -v python3 >/dev/null 2>&1; then ok "python3: $(python3 --version 2>&1)"; else fail "python3 not on PATH"; fi

# gh is optional. We probe it here; the runs scan below escalates to a hard
# failure for any run whose metadata sets github_cli_required: "true".
GH_AVAILABLE=0
if command -v gh >/dev/null 2>&1; then
  GH_AVAILABLE=1
  if gh auth status >/dev/null 2>&1; then
    ok "gh: $(gh --version | head -n 1) (authenticated)"
  else
    ok "gh: $(gh --version | head -n 1)"
    warn "gh is installed but not authenticated. Run 'gh auth login' before opening PRs."
  fi
else
  warn "gh (GitHub CLI) is not installed. open-pr.sh / check-pr.sh require it. Install: https://cli.github.com/"
fi

# bd (Beads) is optional. Sync-to-beads.sh short-circuits if missing.
BD_AVAILABLE=0
BD_INITIALIZED=0
if command -v bd >/dev/null 2>&1; then
  BD_AVAILABLE=1
  BD_VER="$(bd --version 2>&1 | head -n 1)"
  # Use `bd info` rather than `[[ -d .beads ]]` so we honor bd's own
  # ancestor walk (in worktree setups, .beads/ may live at the parent repo).
  if bd info >/dev/null 2>&1; then
    BD_INITIALIZED=1
    ok "bd: ${BD_VER} (initialized)"
  else
    ok "bd: ${BD_VER}"
    warn "bd is installed but no .beads/ database is reachable. Run 'bd init --non-interactive --prefix wb' to enable Beads sync."
  fi
else
  warn "bd (Beads CLI) is not installed. Beads sync will be skipped. Install from: https://github.com/steveyegge/beads"
fi

# --- Directory structure ------------------------------------------------------

echo
echo "[directories]"
REQUIRED_DIRS=(
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
for dir in "${REQUIRED_DIRS[@]}"; do
  if [[ -d "${dir}" ]]; then ok "${dir}/"; else fail "missing directory: ${dir}/"; fi
done

# --- Templates ----------------------------------------------------------------

echo
echo "[templates]"
REQUIRED_TEMPLATES=(
  "raw-idea.md"
  "normalized-feature-input.md"
  "spec.md"
  "run-log.md"
  "decisions.md"
  "qa-log.md"
  "pr-summary.md"
  "metadata.yaml"
)
for tpl in "${REQUIRED_TEMPLATES[@]}"; do
  if [[ -f "templates/${tpl}" ]]; then ok "templates/${tpl}"; else fail "missing template: templates/${tpl}"; fi
done

# --- Python helpers -----------------------------------------------------------

echo
echo "[lib]"
if PYTHONPATH="${WORKBENCH_ROOT}" python3 - <<'PY' >/dev/null 2>&1
from lib import paths, repo_config, metadata, _yaml, events, transitions
PY
then
  ok "lib/ helpers import cleanly"
else
  fail "lib/ helpers failed to import (run: PYTHONPATH=. python3 -c 'from lib import paths, repo_config, metadata')"
fi

# --- repos.yaml ---------------------------------------------------------------

echo
echo "[config]"
if [[ -f "config/repos.yaml" ]]; then
  CONFIG_OUTPUT="$(
    PYTHONPATH="${WORKBENCH_ROOT}" python3 - <<'PY' 2>&1 || true
from lib.repo_config import load_config, validate_paths_on_disk, ConfigError
try:
    cfg = load_config()
except ConfigError as exc:
    print(f"PARSE_ERR:{exc}")
    raise SystemExit(0)
print(f"COUNT:{len(cfg)}")
for problem in validate_paths_on_disk(cfg):
    print(f"DISK:{problem}")
PY
  )"
  if grep -q '^PARSE_ERR:' <<<"${CONFIG_OUTPUT}"; then
    fail "config/repos.yaml: $(grep '^PARSE_ERR:' <<<"${CONFIG_OUTPUT}" | sed 's/^PARSE_ERR://')"
  else
    count="$(grep '^COUNT:' <<<"${CONFIG_OUTPUT}" | sed 's/^COUNT://')"
    ok "config/repos.yaml parses (${count} repo(s))"
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      warn "${line#DISK:}"
    done < <(grep '^DISK:' <<<"${CONFIG_OUTPUT}" || true)
  fi
else
  warn "config/repos.yaml not present (copy from config/repos.yaml.example to enable run scripts)"
fi

# --- Existing run metadata ----------------------------------------------------

echo
echo "[runs]"
RUN_COUNT=0
if [[ -d "runs" ]]; then
  while IFS= read -r run_dir; do
    [[ -n "${run_dir}" ]] || continue
    [[ -f "${run_dir}/metadata.yaml" ]] || { warn "no metadata.yaml in ${run_dir}"; continue; }
    RUN_COUNT=$((RUN_COUNT + 1))
    # Probe the run. Output is a `key=value` block on stdout for parseability;
    # first line is either OK or ERR.
    META_PROBE="$(
      PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${run_dir}" <<'PY' 2>&1 || true
import sys
from pathlib import Path
from lib.metadata import load, MetadataError
try:
    md = load(Path(sys.argv[1]))
except MetadataError as exc:
    print(f"ERR={exc}")
    raise SystemExit(0)
print("OK=1")
print(f"github_cli_required={(md.github_cli_required or 'false').strip().lower()}")
print(f"run_type={md.run_type}")
print(f"status={md.status}")
print(f"parent_run_id={md.parent_run_id}")
print(f"beads_task_id={md.beads_task_id}")
PY
    )"
    if grep -q '^ERR=' <<<"${META_PROBE}"; then
      ERR_MSG="$(grep '^ERR=' <<<"${META_PROBE}" | head -n 1 | sed 's/^ERR=//')"
      fail "${run_dir}/metadata.yaml: ${ERR_MSG}"
      continue
    fi

    REQUIRED_FLAG="$(grep '^github_cli_required=' <<<"${META_PROBE}" | head -n 1 | sed 's/^github_cli_required=//')"
    RUN_TYPE="$(grep '^run_type=' <<<"${META_PROBE}" | head -n 1 | sed 's/^run_type=//')"
    RUN_STATUS="$(grep '^status=' <<<"${META_PROBE}" | head -n 1 | sed 's/^status=//')"
    PARENT_RUN_ID="$(grep '^parent_run_id=' <<<"${META_PROBE}" | head -n 1 | sed 's/^parent_run_id=//')"
    BEADS_ID="$(grep '^beads_task_id=' <<<"${META_PROBE}" | head -n 1 | sed 's/^beads_task_id=//')"

    SUMMARY="${run_dir}/metadata.yaml [${RUN_TYPE}/${RUN_STATUS}]"

    # Children count for investigation runs.
    if [[ "${RUN_TYPE}" == "investigation" ]]; then
      RUN_ID_BASENAME="$(basename "${run_dir}")"
      CHILDREN_COUNT=0
      while IFS= read -r child_meta; do
        [[ -z "${child_meta}" ]] && continue
        if grep -qE "^parent_run_id: \"?${RUN_ID_BASENAME}\"?$" "${child_meta}"; then
          CHILDREN_COUNT=$((CHILDREN_COUNT + 1))
        fi
      done < <(find runs -mindepth 2 -maxdepth 2 -name metadata.yaml 2>/dev/null)
      SUMMARY="${SUMMARY} children=${CHILDREN_COUNT}"
    fi

    # Beads task id surfaced for at-a-glance.
    if [[ -n "${BEADS_ID}" ]]; then
      SUMMARY="${SUMMARY} bead=${BEADS_ID}"
    fi

    ok "${SUMMARY}"

    # gh-required gate (existing rule).
    if [[ "${REQUIRED_FLAG}" == "true" && "${GH_AVAILABLE}" -eq 0 ]]; then
      fail "${run_dir}: github_cli_required=true but gh is not installed"
    fi

    # Parent dir existence (warn-only, since rename/move is legal cleanup).
    if [[ -n "${PARENT_RUN_ID}" ]]; then
      if [[ ! -d "runs/${PARENT_RUN_ID}" ]]; then
        warn "${run_dir}: parent_run_id=${PARENT_RUN_ID} but runs/${PARENT_RUN_ID} not found"
      fi
    fi

    # Beads sync drift (warn-only, since Beads is optional).
    if [[ "${BD_AVAILABLE}" -eq 1 && "${BD_INITIALIZED}" -eq 1 ]]; then
      if [[ -n "${BEADS_ID}" ]]; then
        if ! bd show "${BEADS_ID}" --json >/dev/null 2>&1; then
          warn "${run_dir}: beads_task_id=${BEADS_ID} but bd show cannot find it (run sync-to-beads.sh)"
        fi
      else
        # No bead recorded for a non-draft run: likely needs a sync.
        if [[ "${RUN_STATUS}" != "draft" ]]; then
          warn "${run_dir}: status=${RUN_STATUS} but no beads_task_id (run sync-to-beads.sh)"
        fi
      fi
    fi

    # Event-log consistency. events.jsonl is created by the lifecycle scripts;
    # if it exists, the latest TransitionApplied event must match metadata.status.
    # Runs created before this check was added simply have no events.jsonl and
    # are skipped silently.
    if [[ -f "${run_dir}/events.jsonl" ]]; then
      EVENT_PROBE="$(
        PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${run_dir}" "${RUN_STATUS}" <<'PY' 2>&1 || true
import sys
from pathlib import Path
from lib.events import last_transition, EventError
try:
    ev = last_transition(Path(sys.argv[1]))
except EventError as exc:
    print(f"PROBE_ERR:{exc}")
    raise SystemExit(0)
expected = sys.argv[2]
if ev is None:
    print("NO_TRANSITION")
elif ev.to_state != expected:
    print(f"DRIFT:{ev.to_state}|{expected}")
else:
    print("OK")
PY
      )"
      case "${EVENT_PROBE}" in
        OK) ;;
        NO_TRANSITION)
          # Allowed only for runs that have never transitioned (status=draft).
          if [[ "${RUN_STATUS}" != "draft" ]]; then
            warn "${run_dir}: events.jsonl has no TransitionApplied but status=${RUN_STATUS}"
          fi
          ;;
        DRIFT:*)
          DRIFT="${EVENT_PROBE#DRIFT:}"
          fail "${run_dir}: event-log drift — events to_state=${DRIFT%%|*}, metadata status=${DRIFT##*|}"
          ;;
        PROBE_ERR:*)
          fail "${run_dir}: events.jsonl unreadable: ${EVENT_PROBE#PROBE_ERR:}"
          ;;
        *)
          warn "${run_dir}: events.jsonl probe returned unexpected: ${EVENT_PROBE}"
          ;;
      esac
    fi
  done < <(find runs -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi
[[ ${RUN_COUNT} -eq 0 ]] && note "(no runs yet)"

# --- Summary ------------------------------------------------------------------

echo
if [[ "${errors}" -gt 0 ]]; then
  echo "validation failed: ${errors} error(s), ${warnings} warning(s)" >&2
  exit 1
fi
echo "validation ok (${warnings} warning(s))"
