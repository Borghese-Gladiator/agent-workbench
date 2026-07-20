# Python: dependencies

Applies when: adding, removing, or upgrading a Python dependency.

Do:

- Add via `poetry add <pkg>` (runtime) or `poetry add --group dev <pkg>` (dev-only).
- Commit `poetry.lock` along with `pyproject.toml` in the same commit.
- Pin major versions in `pyproject.toml` for libraries; let Poetry resolve patches.
- Run the suite after any dependency change. Lockfile churn can silently break things.
- Use `poetry update <pkg>` for upgrades; review the lockfile diff before committing.

Do not:

- Do not edit `poetry.lock` by hand. Regenerate it.
- Do not run `pip install` in a Poetry project. Use Poetry exclusively.
- Do not pin to `*` or `>=x.y` without an upper bound for libraries.
- Do not add a dependency without checking whether the repo already depends on something equivalent.

Commands:

```bash
poetry add <pkg>
poetry add --group dev <pkg>
poetry remove <pkg>
poetry update <pkg>

# Check what's already pinned and resolved
poetry show --tree | head -50
git diff poetry.lock | head
```
