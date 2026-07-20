#!/usr/bin/env bash
#
# validate-product-repos-clean.sh
#
# Walk every repo registered in config/repos.yaml and warn if it contains
# orchestration directories that should live ONLY in ai-workbench.
#
# Forbidden top-level directories in product repos:
#   /specs   /runs   /ai   /beads   /logs
#
# Exits 0 if all clean, 1 if any forbidden dir is found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${WORKBENCH_ROOT}"

FORBIDDEN=(specs runs ai beads logs)

echo "scanning configured product repos for orchestration leakage..."

# Get the list of repo paths via Python so YAML parsing stays in one place.
# We emit project_dir (the agent's working directory), not the git root.
# For subdirectory projects this is `path/project_subpath`; for top-level
# projects it equals `path`. The "no orchestration leakage" rule applies
# inside the project, not at the git root.
REPO_LINES="$(
  PYTHONPATH="${WORKBENCH_ROOT}" python3 - <<'PY'
from lib.repo_config import load_config, ConfigError
try:
    cfg = load_config()
except ConfigError as exc:
    print(f"ERR:{exc}")
    raise SystemExit(2)
for entry in cfg.values():
    print(f"{entry.repo_key}\t{entry.project_dir}")
PY
)" || {
  echo "${REPO_LINES}" >&2
  exit 2
}

if [[ -z "${REPO_LINES}" ]]; then
  echo "no repos configured; nothing to scan"
  exit 0
fi

problems=0
while IFS=$'\t' read -r repo_key project_dir; do
  [[ -n "${repo_key}" ]] || continue
  if [[ ! -d "${project_dir}" ]]; then
    echo "  skip ${repo_key}: project dir not present (${project_dir})" >&2
    continue
  fi
  for dir in "${FORBIDDEN[@]}"; do
    candidate="${project_dir}/${dir}"
    if [[ -e "${candidate}" ]]; then
      echo "  FORBIDDEN ${repo_key}: ${candidate} should not exist (orchestration belongs in ai-workbench)" >&2
      problems=$((problems + 1))
    fi
  done
done <<<"${REPO_LINES}"

if [[ "${problems}" -gt 0 ]]; then
  echo "found ${problems} forbidden path(s). Move the contents into runs/<run_id>/ inside ai-workbench." >&2
  exit 1
fi

echo "all configured product repos are clean."
