# Infra: CI

Applies when: a CI run is failing, or about to modify `.github/workflows/`, `.buildkite/`, `.circleci/`, etc.

Do:

- Mirror CI checks locally before pushing. The same lint / typecheck / test commands.
- Prefer repo-local scripts (`bin/ci`, `scripts/ci`) over duplicating commands in the workflow file.
- Pin action versions to a tag or SHA, not `@main`.
- Keep job names stable; downstream tools (required checks, dashboards) bind on them.
- When you change a workflow, run it on a feature branch first.

Do not:

- Do not weaken CI to make a PR green. The check exists for a reason; fix the code.
- Do not silently skip a check (`continue-on-error: true`) without documenting why and adding a TODO.
- Do not move a long-running check to nightly to dodge a flake. Fix the flake.
- Do not store secrets in workflow files. Use the CI provider's secret store.

Commands:

```bash
# Inspect CI config
ls .github/workflows/ .buildkite/ .circleci/ 2>/dev/null

# Run the same commands locally that CI runs
# (read the workflow file; mirror exactly)

# Tail recent runs
gh run list --limit 10
gh run view <run-id>
```
