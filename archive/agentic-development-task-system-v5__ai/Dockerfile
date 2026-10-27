# Agentic Workbench — container image for the temporal-worker + daemon + web.
#
# This is NOT the archived v4 image (single `tsx`-run daemon+web). The current
# stack runs the COMPILED `dist/` output of a pnpm-workspace `tsc` build across
# packages/*, workers/*, and apps/* — the same build `pnpm build` produces — so
# the worker + daemon run `node dist/index.js`, matching the `pinned` runtime
# mode in apps/cli/src/services.ts. One image serves all three JS services;
# docker-compose runs it with a different `command:` per service.
#
# node>=20 (package.json engines) and pnpm@10.33.0 pinned via corepack from the
# `packageManager` field. better-sqlite3 is a native module, so the build stage
# carries python3/make/g++.

# ---- base: toolchain + pinned pnpm ----------------------------------------
FROM node:20-bookworm-slim AS base

# - python3/make/g++: compile better-sqlite3 for this image's Node ABI.
# - git: the daemon + workspace layer shell out to git (worktree create/status/diff).
# - ca-certificates: TLS for network fetches during install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# corepack activates the exact pnpm from package.json's `packageManager` field.
RUN corepack enable

WORKDIR /app

# ---- build: install workspace deps, then `tsc` build the whole workspace ----
FROM base AS build

# Copy the whole workspace. A manifest-only pre-copy (v4's cache trick) is brittle
# here because the workspace has ~18 packages whose manifests all have to be listed
# by hand and drift silently; copying the tree keeps the build correct. (.dockerignore
# already excludes node_modules / dist / data so the context stays small.)
COPY . .

# Reproducible install (runs any native rebuild for better-sqlite3), then the same
# tsc build `pnpm build` runs: packages → workers → apps, in dependency order.
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime: install + built dist, no build toolchain by default ----------
FROM base AS runtime

ENV NODE_ENV=production

# Bring the installed node_modules and the built workspace (with dist/) from build.
COPY --from=build /app /app

# daemon API (4417) + web dev server (5317). Temporal (7233) + OTLP (4318) are
# other services in the compose file, not this image.
EXPOSE 4417 5317

# Default to the daemon; compose overrides `command:` for worker + web.
CMD ["node", "apps/daemon/dist/index.js"]
