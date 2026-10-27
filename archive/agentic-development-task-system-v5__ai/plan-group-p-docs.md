# Plan — Group P slice: docs / skill / containerization (TASK-102 / 101 / 95 / 97)

## brief
Ship-independent deliverables, no runtime coupling:
- TASK-102: `.claude/skills/grill-me/SKILL.md` — adversarial plan/contract interrogation skill
  (frontmatter name+description matching repo convention). Outputs a findings list.
- TASK-101: root `Dockerfile` + `docker-compose.yml` bringing up otel(grafana/otel-lgtm) +
  local Temporal(SQLite) + temporal-worker + daemon + web, mirroring `RUNTIME_SERVICES` in
  `apps/cli/src/services.ts`. node>=20, corepack pnpm@10.33.0, pnpm-workspace tsc build.
  No k8s/postgres/redis; NOT a blind copy of archive/ v4.
- TASK-95 writeup: `docs/token-saving-proxy-evaluation.md` — RTK/Caveman/Headroom keep/decline
  + SDK-interception caveat.
- TASK-97 writeup: `docs/subagent-policy-decision.md` — per-runtime keep-denied/enable-scoped
  decision for OpenCode/Pi with containment analysis.

## changes
1. `.claude/skills/grill-me/SKILL.md` — new skill.
2. `Dockerfile` — multi-stage: corepack pnpm@10.33.0, install, tsc build, runtime image.
3. `docker-compose.yml` — otel + temporal + worker + daemon + web services mirroring RUNTIME_SERVICES.
4. `docs/token-saving-proxy-evaluation.md` — TASK-95 proxy decision.
5. `docs/subagent-policy-decision.md` — TASK-97 subagent policy decision.
6. `package.json` — add `gray-matter` devDependency (required by the targeted frontmatter check).

## tests
### unit
- Targeted: `docker compose config -q` parses.
- Targeted: `node -e` gray-matter parse of SKILL.md → name+description present.

### manual
- Validate grill-me surfaces concrete gaps on a real plan (run its instructions against plan.md).
- `docker compose config` prints the resolved config with all 5 services.
