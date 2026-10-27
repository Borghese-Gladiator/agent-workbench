# Agent Workbench — container image.
#
# One image serves both processes (daemon + web dev server); docker-compose
# runs it twice with different commands. The app runs under `tsx` (no build
# step needed — packages resolve via their `exports` to src/*.ts), so the
# image just needs the toolchain + an installed node_modules.
#
# better-sqlite3 is a native module. `pnpm install` triggers the repo's
# `postinstall` (scripts/fix-sqlite-binding.mjs), which compiles its binding
# for THIS image's Node ABI from source — so python3/make/g++ must be present.

# Pin the Node major to match .nvmrc (v24.x). bookworm-slim has the apt repos
# we need for the native build toolchain.
FROM node:24-bookworm-slim AS base

# - python3/make/g++: build better-sqlite3 from source for the container ABI.
# - git: the daemon shells out to git (worktree create/status/diff). Even in
#   the default mock-runtime flow, git must exist on PATH.
# - ca-certificates: TLS for prebuild-install / network fetches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin pnpm from package.json's `packageManager` field via corepack.
RUN corepack enable

WORKDIR /app

# ---- deps: install with a warm, cache-friendly layer -----------------------
FROM base AS deps

# Copy only manifests + lockfile first so `pnpm install` is cached unless a
# dependency actually changes. Mirror the workspace layout so every package
# manifest is present before install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json        packages/core/package.json
COPY packages/store/package.json       packages/store/package.json
COPY packages/worktree/package.json    packages/worktree/package.json
COPY packages/agents/package.json      packages/agents/package.json
COPY packages/validation/package.json  packages/validation/package.json
COPY packages/delivery/package.json    packages/delivery/package.json
COPY apps/daemon/package.json          apps/daemon/package.json
COPY apps/web/package.json             apps/web/package.json
COPY scripts ./scripts

# --frozen-lockfile: reproducible installs. Runs `postinstall` →
# fix-sqlite-binding, which compiles better-sqlite3 for the container Node.
RUN pnpm install --frozen-lockfile

# ---- runtime: full source + installed deps ---------------------------------
FROM base AS runtime

ENV NODE_ENV=development

# Bring in the resolved node_modules (root + per-package hoisted) from deps.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps

# Then the rest of the source (overlays the manifests already copied above).
COPY . .

# daemon API + web dev server.
EXPOSE 4317 5317

# Default to the daemon; compose overrides `command:` for the web service.
CMD ["pnpm", "daemon"]
