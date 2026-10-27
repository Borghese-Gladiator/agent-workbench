# Python: setup

Applies when: setting up a Python project locally; about to install or upgrade Python itself.

Do:

- Default to Poetry. Pin the Python version in `pyproject.toml` (`tool.poetry.dependencies.python = "^3.11"` or similar).
- Install Python via `pyenv` or the platform package manager; never overwrite the system Python.
- Use a Poetry-managed venv: `poetry install` creates and uses it. Don't activate venvs by hand unless debugging.
- If the repo has `bin/` scripts (`bin/setup`, `bin/install`), prefer them over invoking Poetry directly.
- Match the Python version `pyproject.toml` pins; CI will fail if you don't.

Do not:

- Do not install dependencies into the system Python. Always use the project venv.
- Do not use `conda` and `Poetry` together. Pick one per project.
- Do not commit your local venv or `.python-version` overrides unless the repo asks for them.
- Do not assume Python 3.x; check `pyproject.toml` for the pinned range.

Commands:

```bash
# Detect what's pinned
grep -E 'python\s*=' pyproject.toml

# Standard setup
poetry env use 3.11
poetry install

# Or — repo-local script if present
ls bin/setup bin/install 2>/dev/null
```
