# Python: testing

Applies when: writing, running, or modifying Python tests.

Do:

- Run tests via `bin/pytest` if the repo provides it; else `poetry run pytest`.
- Mirror source layout in `tests/` — one test module per source module.
- Use `@pytest.mark.parametrize` to merge tests with identical setup that differ only in assertions.
- Use fixtures (`@pytest.fixture`) to factor shared setup; don't copy-paste construction across tests.
- Prefer `assertIn` / `assertGreater` over over-specified `assertEqual` when the surrounding code is allowed to evolve.
- Add a regression test for every bug you fix, even if the test seems trivial. Tag it with the issue or commit SHA in the docstring.

Do not:

- Do not test third-party library internals; test your wrapper around them.
- Do not write tests that assert framework behavior (e.g. `argparse` rejecting an unknown flag).
- Do not mock the database in integration tests when a real test DB is available — mock/prod divergence hides bugs.
- Do not let test files exceed one screen of setup before the first assertion. Factor.

Commands:

```bash
# Run one file
bin/pytest tests/path/test_thing.py

# Run one test
bin/pytest tests/path/test_thing.py::TestThing::test_specific

# Full suite (fall back if no bin/pytest)
poetry run pytest -q
```
