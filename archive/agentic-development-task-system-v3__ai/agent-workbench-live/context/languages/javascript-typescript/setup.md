# JS/TS: setup

Applies when: setting up a JavaScript or TypeScript project locally.

Do:

- Default to Yarn. The repo's lockfile (`yarn.lock` vs `package-lock.json` vs `pnpm-lock.yaml`) is the source of truth; match it.
- TypeScript by default for new code, even in JS-heavy repos. New files end in `.ts` / `.tsx`.
- Pin the Node version in `.nvmrc` or `package.json` `engines.node`. Use `nvm use` to match.
- Run `yarn install` from the repo root; respect workspace topology (turborepo, Nx, Yarn workspaces).
- Prefer repo-local scripts (`bin/setup`, `package.json` `scripts`) over invoking tools directly.

Do not:

- Do not `npm install` in a Yarn repo. The lockfile drift will be a silent bug.
- Do not install globals (`npm install -g`) for tools the repo already manages.
- Do not commit `node_modules/` or your editor's IDE caches.
- Do not assume Node 20; check `.nvmrc` or `engines.node`.

Commands:

```bash
# Detect what's pinned
cat .nvmrc 2>/dev/null
grep -E '"engines"|"node"' package.json

# Standard setup
nvm use
yarn install --immutable

# Workspace topology
yarn workspaces list
```
