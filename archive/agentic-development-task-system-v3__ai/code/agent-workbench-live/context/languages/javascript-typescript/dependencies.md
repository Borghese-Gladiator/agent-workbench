# JS/TS: dependencies

Applies when: adding, removing, or upgrading a JS/TS dependency.

Do:

- Add via `yarn add <pkg>` (runtime) or `yarn add -D <pkg>` (devDependency).
- In a workspaces / monorepo repo, add to the specific package: `yarn workspace @scope/pkg add <pkg>`.
- Commit `yarn.lock` with `package.json` in the same commit.
- Prefer first-party types (`@types/<pkg>`) over `any`-typed imports.
- Run the suite after any dependency change. Lockfile churn breaks transitive deps quietly.

Do not:

- Do not hand-edit `yarn.lock`. Regenerate it.
- Do not pin every dependency to `^x.y.z` and then `yarn install --immutable` — pick one strategy.
- Do not add a dependency for something the project already has (lodash vs. underscore, axios vs. fetch).
- Do not silently introduce `peerDependencies` without recording them in `package.json`.

Commands:

```bash
yarn add <pkg>
yarn add -D <pkg>
yarn workspace @scope/pkg add <pkg>
yarn remove <pkg>
yarn dedupe

# Audit
yarn why <pkg>
git diff yarn.lock | head
```
