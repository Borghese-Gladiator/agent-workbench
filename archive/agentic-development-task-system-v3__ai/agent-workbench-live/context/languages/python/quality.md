# Python: quality

Applies when: about to commit, push, or open a PR with Python changes.

Do:

- Run all four before push: `ruff check`, `ruff format --check`, `mypy`, `pytest`.
- Prefer repo-local scripts (`bin/lint`, `bin/typecheck`) if they exist — they may set extra flags CI uses.
- Type hints are not optional in new code. Annotate function signatures and return types.
- Treat `mypy` warnings as errors; if you must suppress one, narrow it (`# type: ignore[specific-code]`).
- Match the repo's import order (Ruff handles it via `I` rules); don't fight the formatter.

Do not:

- Do not `# type: ignore` blanket — always include the specific error code.
- Do not run `black` and `ruff format` together. Pick one (Ruff for new repos).
- Do not relax `pyproject.toml` lint rules to make CI pass. Fix the code.
- Do not catch broad `Exception` to silence type checker complaints.

Commands:

```bash
ruff check .
ruff format --check .
mypy .
pytest -q

# One-shot before push
ruff check . && ruff format --check . && mypy . && pytest -q
```
