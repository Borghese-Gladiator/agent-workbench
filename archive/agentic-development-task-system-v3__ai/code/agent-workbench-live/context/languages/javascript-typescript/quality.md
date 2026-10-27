# JS/TS: quality

Applies when: about to commit, push, or open a PR with JS/TS changes.

Do:

- Run all three before push: `yarn lint`, `yarn typecheck`, `yarn build` (then `yarn test`).
- Prefer package-specific typecheck over root in a monorepo — CI uses stricter project-reference resolution.
- Match the repo's import-order and formatting rules; don't fight the linter or formatter.
- Treat TypeScript errors as build failures, not warnings.
- Run `yarn format` (or `prettier --write`) before committing, but check first that the repo isn't using a no-format convention.

Do not:

- Do not introduce `any`. Use `unknown` with narrowing if the type is genuinely unknown.
- Do not relax `tsconfig.json` `strict` flags to make a build pass.
- Do not commit `.eslintrc` overrides that silence rules globally; scope them to the file.
- Do not skip `yarn build` because tests pass — runtime errors hide behind unbuilt code.

Commands:

```bash
yarn lint
yarn typecheck
yarn build
yarn test

# Monorepo, one package (CI parity)
turbo lint --filter "@scope/pkg"
turbo check-types --filter "@scope/pkg"
```
