# JS/TS: testing

Applies when: writing, running, or modifying JS/TS tests.

Do:

- Run via `yarn test` or the repo's specific runner script. In a monorepo, scope to one package: `turbo test --filter @scope/pkg`.
- For React Testing Library: prefer `getByRole(role, { name })` over `getByTestId`, `getByText`, or translated equivalents.
- Use `it.each` / `test.each` (or framework equivalent) to merge tests with identical setup that differ only in assertions.
- Mock at boundaries (network, time, FS), not at the unit under test.
- Avoid `waitFor` when a synchronous `getByRole` will do; it slows tests and hides race conditions.

Do not:

- Do not test third-party component internals; test your wrapper.
- Do not pin assertions to exact rendered strings if `assertIn`-style is enough — those break on i18n.
- Do not leave `console.log` in committed tests.
- Do not run tests in `--watch` mode in CI scripts.

Commands:

```bash
# Standard
yarn test

# One file
yarn test path/to/file.test.ts

# Monorepo, one package
turbo test --filter "@scope/pkg" -- path/to/file.test.tsx
```
