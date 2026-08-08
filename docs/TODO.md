# Backlog
Prioritized List of Things to Fix

Every task should have what is wrong / what to do, where, and how we'll know when it's done



## Group A — Runtime & multi-adapter (foundational)

The profile-driven refactor that unblocks every additional-runtime idea; land
TASK-38 before TASK-44.

### [ ] TASK-38: Runtime gate is hard-coded to `'claude'`, not profile-driven

**What's wrong.** `run-phase.ts` branches on `ctx.strategy === 'claude'` in ~20+
places as *the* gate for the real (non-mock) path — real contract, real planner,
real prepare/worktree, real builder, real QA, real delivery, and even durable run
state (`durable = strategy === 'claude'`). Any other runtime (Pi, Codex,
OpenCode) therefore silently falls back to the MOCK path even when a real adapter
exists. This directly contradicts the RuntimeProfile design ("daemon is
profile-driven, no runtime string branches") — the daemon may be profile-driven,
but the phase activity is not. This is the "hard-coded naming of Claude inside
phases + lots of mock adapters" complaint, and it's the blocker for every
additional-runtime idea below.

**What to do.** Replace the `strategy === 'claude'` checks with a capability/profile
predicate — e.g. `ctx.profile.usesRealAgent` (or `runtimeSupportsRealPhase(ctx)`)
sourced from the RuntimeProfile — so "run the real path" is a property of the
selected runtime, not a string equality on one vendor's name. Keep MOCK as the
one explicit fallback. Grep for every `=== 'claude'` / `!== 'claude'` in the
activities and route each through the predicate; keep the ones that are genuinely
Claude-adapter-specific (if any) named as such.

**Where.** `workers/temporal-worker/src/activities/run-phase.ts` (all
`strategy === 'claude'` sites, lines ~91–1247), the RuntimeProfile definition,
`agent-factory.ts`.

**How we'll know it's done.** *Unit:* a phase test driven by a non-claude profile
whose `usesRealAgent` is true takes the real branch (planner/builder/delivery),
and a mock profile takes the mock branch — asserted without any `'claude'`
literal in the activity. *Manual:* a Pi/Codex profile run reaches a real builder
edit instead of a fake candidate.

### [ ] TASK-44: Add runtime adapters — Codex, Pi, OpenCode (depends on TASK-38)

**What's wrong.** Only `claude-adapter` and `mock-adapter` live in
`packages/agent-gateway/src/`. Pi and Codex adapters were prototyped on worktree
branches but never merged, and the phase gate (TASK-38) would ignore them anyway.
OpenCode is a net-new integration with useful subagent semantics.

**What to do.** After TASK-38 makes the real path profile-driven: land a
`RuntimeProfile` + adapter per runtime (start with whichever is closest to
merge-ready), each conforming to the existing `adapter.ts` contract. Keep external
tooling model-agnostic per the standing learning (daemon-seeded env + recipe
cards, no claude-gating). OpenCode's per-file agent loop (`opencode run --agent …`
over a file list) is a strong fit for the builder's per-slice model and for
en-masse mechanical fixes.

**Where.** `packages/agent-gateway/src/*-adapter.ts`, RuntimeProfile registry,
`agent-factory.ts`, per-project `runtimeConfig`.

**How we'll know it's done.** *Unit:* each adapter passes the shared adapter
conformance tests. *Manual:* a real (draft) PR produced under at least one
non-claude runtime, as previously proven for Pi on `wip-browser-games`.


## Group C — Quality gates

### [ ] TASK-63: `exercise` QA gate is inconsistent — passed an EMPTY change (Pi) yet blocked a real one (OpenCode), same model

**What's wrong.** Driving the *identical* trivial task ("add a one-line note to
README.md stating how many games are available") on `wip-browser-games` under two
runtimes, both on the same local model `ollama/qwen3-coder:30b`, produced opposite
QA outcomes that were both wrong:

- **Pi run (`878058b7`, 2026-08-07):** the builder committed **only
  `package-lock.json` — no README change at all** (`git diff base..HEAD -- README.md`
  empty). `exercise` nonetheless **cleared on attempt 1**, the run reached `release`,
  and opened draft PR `browser-games__ai#13`. QA green on a **no-op**.
- **OpenCode run (`082de7e9`, 2026-08-08):** the builder made a **real (off-target)
  README edit** and `exercise` **looped `implement→verify→exercise` 3× → parked at
  `repeated-failure-no-progress`**, never reaching a PR.

Same gate passed the empty candidate and blocked the non-empty one. Both runs
produced `terminal-recording | passed` evidence, so the divergence is in
`evaluateExercise`'s other conditions and/or the plan/contract each planner emitted
— NOT in the QA recording. This is TASK-42's rubber-stamp thesis reproduced: the gate
doesn't verify the behavioral claim's *content* (Pi's empty change passed), and what
does trip it isn't tied to artifact correctness (OpenCode's real change blocked). It
also invalidates the earlier "Pi live-proven end-to-end" claim — PR #13 was empty.

**Two candidate contributors (confirm, don't assume).** (1) Rubber-stamp:
`evaluateExercise` clears without asserting the contract's behavioral claim is
satisfied by the candidate diff, so an empty/no-op candidate passes. (2) Gate skew:
TASK-42's QA-strength hardening landed on `main` *between* the Pi and OpenCode runs,
so the two may have been judged by different gate code. Either way an empty candidate
should never pass.

**What to do.** Instrument `evaluateExercise` to log the exact `missing[]` per attempt,
re-run one OpenCode task, capture the failing condition. Then make the gate reject a
candidate whose committed diff doesn't touch the artifact the behavioral claim is
about, and confirm the CLI-QA path (not just browser QA) enforces the TASK-42
strong-assertion requirement. Runtime-independent — a workbench QA-gate bug, not an
adapter defect; the OpenCode/Pi adapters have full feature parity (both drive the same
`runBuilderSession` git-candidate path).

**Where.** `packages/workflow/src/evaluate-completion.ts` (`evaluateExercise` + temp
`missing[]` logging), `packages/workflow/src/completion-context.ts` (`exercise` fields),
`packages/qa/` (CLI-QA assertion strength), plan→contract claim wiring. Relates to
TASK-42 and the `qa-static-checks-miss-runtime-bugs` / `qa-cold-reentry-nonconvergence`
learnings.

**How we'll know it's done.** *Unit:* an `evaluateExercise` test where the committed
diff does NOT touch the claim's target artifact leaves `missing` non-empty (a no-op
candidate like Pi's fails). *Manual:* re-drive the README task under OpenCode and
confirm it either produces a real note that passes QA, or is blocked with a *correct*
reason (missing note) — never the current split where empty passes and real-but-wrong
loops forever.


## Group G — Legibility, DX & dogfooding

Lower-risk, mostly-docs/skills work + the honest self-dogfood.

### [ ] TASK-45: Repo-structure legibility — per-directory AGENT(S).md + one global map

**What's wrong.** A recurring agent-legibility gap (see the 2026-07-20 audit):
`workers/` has no README convention and `run-phase.ts` is an 806-line hub. The
idea list asks for "every directory explains itself" + "global understanding in
one file" + "business logic separated from framework glue".

**What to do.** Adopt a light convention: a top-level map (extend `AGENTS.md` or a
new `docs/map.md`) that names each package's job in one line, and a short
`AGENTS.md` (or `README.md`) in the directories that lack one, starting with
`workers/temporal-worker/src/activities/`. Don't over-engineer — one paragraph per
directory, not a doc framework.

**Where.** `AGENTS.md`, `workers/**`, package dirs missing a readme.

**How we'll know it's done.** Every top-level package + the activities dir has a
one-line self-description reachable from a single map file.

### [ ] TASK-48: "Implement a feature" skill

**What's wrong.** There's no repo skill that captures the house workflow for
implementing a feature through the workbench (plan-first, slice sizing, gate
answers, verify). We have `run-workbench-task` (drives the pipeline) but not an
authoring/planning skill for feature work.

**What to do.** Add a `.claude/skills/` skill that encodes the feature-implementation
workflow (plan.md first per the global CLAUDE.md, converge the contract, keep
slices few, verify). Keep it thin and point at existing skills rather than
duplicating them.

**Where.** `.claude/skills/`.

**How we'll know it's done.** The skill exists and, invoked on a small feature,
produces a plan + drives it without re-deriving the workflow each time.

### [x] TASK-59: `awb up` can't run two stacks at once — hard-coded ports + worktree-broken `repoRoot()`

**What's wrong.** Trying to drive a live task from a git worktree while other
worktree sessions were running (the normal state when several groups are in flight)
surfaced a cluster of related defects that make a second, isolated stack effectively
un-runnable — found live while doing the TASK-46 dogfood:

1. **All service ports are hard-coded single-instance constants** — `DAEMON_PORT =
   4417`, `TEMPORAL_PORT = 7233`, the OTel collector's `4318`/`3000`, and the
   fixed container name `awb-otel-lgtm` (`apps/cli/src/services.ts`), plus the
   task queue name `awb-task-queue` (duplicated in
   `workers/temporal-worker/src/index.ts` and
   `apps/daemon/src/temporal-worker-constants.ts`). Two checkouts' `awb up` therefore
   collide on every port, share one Temporal server, and — worst — share one task
   queue, so a workflow task can be executed by *another worktree's worker running
   different code*.
2. **`awb up`'s health check treats "port open" as "my service is healthy."** When a
   peer already holds 4417/7233, `up` reports `runtime ready` against the *foreign*
   daemon while this checkout's own daemon has actually crashed on `EADDRINUSE` — a
   false green that then fails confusingly at `task create` (Internal Server Error
   against a daemon using a different DB/queue).
3. **`repoRoot()` is wrong for nested worktrees.** It resolves a fixed
   `../../../..` from `apps/cli/src/services.ts`
   (`apps/cli/src/services.ts:39-41`), which climbs past the checkout root when the
   repo is a worktree nested under `LOCAL_worktrees/<repo>/<branch>/`. Pinned mode
   then sets the worker/daemon `cwd` to a directory that doesn't exist → `spawn …
   ENOENT`; dev mode's `pnpm --filter` resolves `@awb/daemon` to a *sibling
   worktree's* package and boots the wrong code (observed: a group-E `up` importing
   `group-a-opencode/apps/daemon`).
4. **Pinned mode spawns bare `node`.** `command: 'node'` (not `process.execPath`) in
   the pinned service defs `ENOENT`s when the detached spawn's PATH lacks the active
   node (e.g. fnm), and — if PATH is forced — can pick up a *different* node whose
   ABI mismatches the compiled `better-sqlite3` (`NODE_MODULE_VERSION` error).
5. **A fresh `AWB_DATA_DIR` isn't fully provisioned before Temporal starts.** Temporal
   `start-dev --db-filename <dataDir>/temporal/temporal.sqlite` crashes with
   "failed checking dir for database file … no such file or directory" because the
   `temporal/` subdir isn't pre-created — yet `up` still reports `runtime ready`
   (health check doesn't catch it), so the daemon later 500s with "Failed to connect
   before the deadline" on the first `task create`. `initDataDir`/`up` should
   `mkdir -p` every service's data subdir first.

Net effect: a clean isolated worktree run needs an isolated `AWB_DATA_DIR` **and**
non-default ports **and** a unique task queue **and** its own Temporal — none of
which are configurable today. The TASK-46 dogfood only completed after local
throwaway edits (env-driven ports/queue/temporal-address, a `repoRoot()` walk-up to
the nearest `pnpm-workspace.yaml`, and `process.execPath` for the spawn); those were
reverted as out-of-scope, and this ticket captures the real fix.

**What to do.** Make a stack fully parameterizable and self-isolating so N worktrees
can run concurrently:
- Env-drive every port + the OTel container name + the task queue, with the current
  values as defaults (single source of truth; the daemon/worker/CLI/vite/worker
  daemon-URL all read the same resolved values). An `awb up` with no overrides
  behaves exactly as today.
- Fix `repoRoot()` to find the checkout root robustly (walk up to the nearest
  `pnpm-workspace.yaml`/`.git`), so pinned cwd and dev `--filter` both target *this*
  worktree. Use `process.execPath` for the pinned `node` spawn.
- Make the health check verify it's *our* service (e.g. a pid/identity check or a
  data-dir-scoped health URL), not merely that the port is occupied — so a foreign
  daemon on the port fails loudly instead of a false "ready".
- Consider an `awb up --isolated` (or deriving a deterministic port block + queue +
  data dir from the branch name) so the multi-worktree case is one flag, not five
  env vars.

**Where.** `apps/cli/src/services.ts` (ports, container name, `repoRoot`,
`process.execPath`), `apps/cli/src/process-control.ts` + `apps/cli/src/health.ts`
(identity-aware health), `apps/cli/src/daemon-client.ts` + `apps/web/vite.config.ts`
+ `workers/temporal-worker/src/daemon-client.ts` (daemon URL), the two `TASK_QUEUE`
definitions, `apps/daemon/src/temporal-client.ts` + `workers/temporal-worker/src/index.ts`
(Temporal address). Relates to TASK-43 (dogfooding this repo is what surfaced it).

**How we'll know it's done.** Two `awb up` stacks from two different worktrees run
simultaneously without collision (distinct ports, queues, Temporal, data dirs), each
drives a task end to end against its own code, and a foreign process on a default
port makes `up` fail with a clear message instead of a false "ready".

### [x] TASK-64: Web UI renders unstyled — layout/semantic CSS classes are used but never defined

**What's wrong.** `apps/web` renders with no layout — the nav collapses to a run of
concatenated text (`RepositoriesTasksApprovalsEvidenceSettings`), repository rows
stack as raw text, no shell/sidebar. The page is *not* entirely style-less: the
`:root`/`.dark` design tokens from `styles.css` apply (dark background, light
foreground), which is what makes this deceptive. The cause is that the app's
structural classes are **referenced in JSX but defined nowhere**:

- `App.tsx` uses `className="app-shell"`, `app-nav`, `app-main`
  (`apps/web/src/App.tsx:13,14,23`) — grep for a definition returns **zero** matches;
  `styles.css` is 120 lines of Tailwind imports + theme tokens only, with no
  component/layout rules.
- The pages/components mix Tailwind utilities (`flex`, `text-sm`,
  `text-muted-foreground`, `gap-2`, `rounded-md`, …) with a second set of **orphaned
  semantic classes** that are likewise undefined: `error`, `note`, `actions`,
  `repository-path`, `task-facts`, `align-top`, etc. The utilities style themselves;
  the semantic classes render as nothing.

This reads as a **half-finished migration**: styling was moved to Tailwind utilities
but a stylesheet's worth of hand-authored layout/semantic classes (an old
`App.css`/`index.css` or component CSS) was removed or never committed, while the JSX
still references those class names. Restarting vite, clearing caches, reinstalling
`@tailwindcss/vite`, and adding `@source` do **not** fix it — those address Tailwind
utility generation, which is a different subsystem from the missing named classes.

**Open thread to resolve first (don't skip).** There is an unexplained
served-vs-applied contradiction: the dev server *serves* a `styles.css` module that
contains utility rules (`.flex`, `.gap-2` present when fetched directly and in the
injected `<style>` per a headless browser), yet the real Chrome tab renders as if no
utilities apply either. Confirm in the *actual* browser (devtools → Elements →
Computed on `.app-nav`, and Sources for the `styles.css` module) whether utilities are
truly absent there too, so the fix targets the real gap and not a headless-vs-real
discrepancy. Do not declare this fixed from a scripted `document.styleSheets` check —
that undercounts modern `@layer`/`@property` CSS and gave false readings here.

**What to do.** (1) Decide the intended styling system for the shell and the orphaned
semantic classes — either author the missing CSS (a real `app-shell`/`app-nav`/
`app-main` layout + the semantic classes) or migrate those JSX references to Tailwind
utilities/components so there are no used-but-undefined class names. (2) Add a guard
so this can't silently regress: a lint/test that fails when a `className` token is
neither a known Tailwind utility nor a defined project class. (3) Resolve the
served-vs-applied thread above before closing.

**Where.** `apps/web/src/App.tsx` (`app-shell`/`app-nav`/`app-main`),
`apps/web/src/styles.css` (missing layout + semantic rules), `apps/web/src/pages/**`
and `apps/web/src/components/**` (orphaned `error`/`note`/`actions`/`repository-path`/
`task-facts`/`align-top`), `apps/web/vite.config.ts` (Tailwind plugin).

**How we'll know it's done.** In a real browser hard-load of `localhost:5317`, the app
has its shell/nav layout (nav is a laid-out bar, not concatenated text) and the
repository list renders as styled rows. *Test:* a check that every `className` token
used in `src/**` resolves to either a Tailwind utility or a defined project class
fails on an undefined name and passes once the shell classes exist.
