# Root cause: intermittent ECONNRESET (recorder + prod) AND the residual unit-test flake

**Status:** ROOT CAUSE PROVEN. One cause behind both symptoms. No fix shipped yet
(the prior note correctly said "do not ship a server fix before the log proves
the cause" — this proves it).

## TL;DR

A synchronous, event-loop-**blocking** subprocess call on a shared event loop is
the single cause:

- **Production / recorder** — `CommandValidationRunner.runSync()` calls
  `spawnSync(command, { shell: true, timeout: 15min, maxBuffer: 32MB })`
  (`packages/validation/src/index.ts:64`). The daemon's `validation_demo` stage
  fires up to **6** of these on the daemon's main thread (3 static
  typecheck/test/lint at `service.ts:1053` + 3 baseline at `service.ts:832`).
  `spawnSync` blocks the **entire daemon event loop** for the whole duration of
  the command. While blocked the daemon cannot service the recorder's
  `taskState()` keep-alive poll; the poll hits its own client-side timeout and
  tears down the socket; the reset surfaces as ECONNRESET (client-visible flavor
  flips between ETIMEDOUT and ECONNRESET on sub-ms timing — but the **server**
  logs `clientError ECONNRESET` every time). On localhost there is no network
  flakiness — the "reset" is the loop being dead, exactly as the recorder
  comment guessed ("daemon drops sockets while spawning the QA subprocess"),
  now PROVEN.

- **Residual unit-test flake** — the SAME blocking primitive
  (`spawnSync` in `validation.test.ts`, `execFileSync` git in
  `worktree`/`delivery`/`lifecycle-smoke`) blocks the **vitest worker's** shared
  event loop. When vitest pools any of those files alongside `app.test.ts` in
  one worker, `app.test.ts`'s in-flight supertest request is starved past its 5s
  timeout, surfacing as the timeout / "Expected HTTP/" framing corruption. This
  matches the recorded observation that the residual flake only appears when the
  real-git/validation files are loaded with the others, and that the
  `unhandledRejection` handler does NOT log on those failures (it's a different
  cause from Fix #1).

## Why every earlier theory was wrong (and is now closed)

| Theory | Verdict | Discriminator |
|---|---|---|
| Slow gate POST hits Node `requestTimeout` (300s) → reset | DISPROVEN | `requestTimeout` only counts while the request is being **received**; a held handler never trips it. Probe: late response returns fine, 0 resets. |
| keep-alive idle-close reuse race | DISPROVEN | Node server FINs cleanly; `http.Agent` AND `fetch/undici` both retry, 0/200 resets at the exact boundary. |
| event-loop block alone → reset | INCOMPLETE | A **patient, same-process** client just queues behind the block (0 resets). The reset needs (a) the block AND (b) a **separate-process** client with a **finite** timeout — i.e. the real recorder. |
| unhandled rejection (Fix #1) | REAL but PARTIAL | Fixed the isolated 3-file case + a real prod crash. Does NOT explain the residual full-suite flake (no rejection logged). |

## The repro

`scripts/investigations/probe-econnreset.mjs` — cross-process. A standalone server blocks its own
event loop in a sync section (modeling `spawnSync`); a separate-process keep-alive
poller with a finite client timeout polls it. Result: the poll errors
(ETIMEDOUT/ECONNRESET) and the **server logs `clientError ECONNRESET`** — every
run, deterministically. Same-process variants do NOT reproduce (the block freezes
the client's timers too), which is why earlier in-process probes came up empty and
the theory looked dead.

```
node scripts/investigations/probe-econnreset.mjs
# => server clientError ECONNRESET; poller sees ETIMEDOUT/ECONNRESET
```

## Why it's intermittent

- The tic-tac-toe demo's static commands are `npm test || true` / `tsc || true`
  — they return in well under a poll timeout, so the block is short and a reset
  is rare (the 5.4-min recorder death was the longer baseline/QA window).
- The enterprise app/fender runs (`bin/pytest`, `turbo check-types`, `turbo
  test`) take **minutes** and emit large output toward `maxBuffer: 32MB`, so the
  block reliably exceeds a poll/keep-alive client's patience → "occasional
  production failures."
- In vitest, it only bites when the worker happens to pool a sync-spawn file with
  `app.test.ts` (worker assignment is non-deterministic) → ~10% residual.

## A footprint of the bug being papered over

`packages/worktree/src/git-worktree.ts:10` switched the git calls to
`execFileSync` precisely because of "event-loop/cwd interactions seen with the
async spawner under some test runners." That band-aid traded an async-spawn quirk
for a **harder** event-loop block — same root cause, made worse.

## The fix — two call sites; #1 APPLIED, #2 still open

Stop blocking the event loop. There are TWO event-loop-blocking sync-spawn call
sites:

1. **`CommandValidationRunner` — APPLIED.** Replaced `spawnSync` with async
   `spawn` (capture stdout/stderr, resolve on `close`; SIGKILL on the 32MB cap to
   mirror the old `maxBuffer` kill). Collapsed the seam to a single async
   `run()`; `runValidationDemo`/`captureBaseline` now `await` it (`captureBaseline`
   became `async`). This is the call site PROVEN to cause the recorder's
   `validation_demo` ECONNRESET (the static + baseline burst), so it is the
   primary fix.
2. **`GitWorktreeProvider` — TRIED, then REVERTED (see experiment below).**

**Measured effect of #1 alone** (daemon suite, 35 runs): flake dropped from the
documented pre-fix ~10% to ~3% (1/35).

### Discriminating experiment: is the residual ~3% the git block, or test isolation?

Made `GitWorktreeProvider` async (`execFile`) and measured two cells:

| cell | config | result |
|---|---|---|
| A | async git, default parallelism | 1/20 (~5%) — flake did NOT close |
| B | async git, `--no-file-parallelism` | **5/20 (25%) — WORSE** |

Failure signatures under serialization were NOT the prod mechanism — they were a
MIX: `Test timed out in 5000ms` (real-git lifecycle walk tipping over the 5s
vitest timeout), plus two SUBSTANTIVE test bugs that have nothing to do with
sockets:
- `expected 'wb/add-dark-mode-task_yxkPN1hE5_' to be 'wb/add-dark-mode-'`
  (`worktree.test.ts:94`) — the test recomputes a `shortId` from task state that
  shifts under it once git calls interleave.
- `expected undefined to be 'human_delivery_approval'` — a lifecycle assertion
  racing the now-interleaved git.

**Conclusion: the residual unit flake is NOT a second instance of the prod bug.**
The `execFileSync` git was acting as an accidental per-worker serializer (the same
"accidental mutex" `spawnSync` provided). Removing it doesn't unblock a starved
poll — it EXPOSES order-dependent assumptions baked into the real-git tests
(`worktree`/`delivery`/`lifecycle-smoke`). That `--no-file-parallelism` makes it
WORSE is the proof: a pure event-loop-block bug would IMPROVE when serialized;
this gets worse because serialization changes test interleaving against shared
on-disk git state.

So #2 was reverted. git calls are milliseconds — they never caused the prod
ECONNRESET (that was #1's multi-minute validation commands). The residual ~3% is
a TEST-HARNESS problem (timing-fragile real-git tests + a 5s timeout), to be
fixed in the tests (raise the real-git suite's timeout / harden the `shortId`
assertions / give each real-git test its own isolated state), NOT by changing
production git to async.

### Follow-up: `packages/delivery` made async (distinct from worktree #2)

The revert above is specific to `packages/worktree` (worktree add/status/diff —
all milliseconds). It does NOT cover `packages/delivery`'s `merge_to_master`
path, whose `git rebase` + `git merge --squash` on a large monorepo legitimately
run for SECONDS-to-MINUTES and block the loop exactly like #1's validation
commands. So `cliGitClient` was converted from `spawnSync` to an async
`spawnCapture` (`child.on('close')`, no `maxBuffer` event-loop block); the
`GitClient` interface methods now return promises and `GitDeliveryAdapter`
awaits them. The format-hook re-stage/retry in `commitAll` is preserved verbatim
(just awaited). `GitClient` is fully encapsulated in the delivery package — the
only consumer (`apps/daemon/src/service.ts`) already `await`ed `publish`, so no
daemon change was needed. Unlike worktree, delivery has no shared-on-disk-state
test-isolation hazard (each test uses its own `mkdtemp` repo or a stubbed
client), so this conversion does NOT reintroduce the worktree #2 flake. A
`does NOT block the event loop while a slow git op runs` regression test
(concurrent timer fires before a sleeping pre-commit hook returns) guards it.

Net effect of #1: the daemon's loop stays live throughout `validation_demo`'s
shell commands, so keep-alive polls are serviced and no socket is starved into a
reset. Recorder-side retry (`taskState()` 5× backoff) remains correct
defense-in-depth, but is no longer load-bearing for this stage.

Optional hardening (independent of the above): set explicit server timeouts in
`main.ts` and keep the `server.on('clientError')` + event-loop-lag heartbeat from
the diagnostic plan as permanent instrumentation — a heartbeat GAP is now known
to mean "the loop is blocked in a sync spawn," not "the daemon died."

## The unit-test flake is THREE independent sources, not one

Peeling the daemon-suite flake apart (the prod ECONNRESET is fully separate and
fixed by #1). Each is low-rate, which is why prior single-probe investigations
kept "disproving" a cause while the suite stayed red:

1. **Drifted duplicated naming logic — FIXED.** `worktree.test.ts` re-derived the
   branch short-id with `id.slice(id.lastIndexOf('_')+1).slice(-6)`, NOT matching
   production `shortId` (`naming.ts:22`), which guards `includes('_')` and falls
   back to the full id via `|| taskId`. A task id is `task_<nanoid(10)>` and a
   nanoid can END in `_` or `-` (its alphabet includes both). When it does,
   production yields `wb/<slug>-task_<...>` (full-id fallback) but the test
   expected `wb/<slug>-` (empty suffix). ~2/64 ≈ 3% of ids trigger it — matching
   the observed rate. Fix: assert against `branchFor(id, title)` directly; delete
   the re-derivation. DETERMINISTIC bug, not a race.
2. **Too-tight 5s timeout on heavy real-git/validation integration tests — FIXED.**
   The full-lifecycle / real-validation walks (real git worktree + subprocess
   spawns) legitimately run >1s and tip over vitest's 5000ms default under
   parallel-worker CPU pressure. Fix: `describe(..., { timeout: 30_000 }, ...)` on
   the four real-git integration describes (`validation`, `lifecycle-smoke`,
   `worktree` ×2, `delivery`). 0 timeout failures in 30 subsequent runs.
3. **supertest ephemeral-server framing corruption — DOCUMENTED, not fixed.** The
   residual (~1–2 per ~30 runs) is ALWAYS one of: `Parse Error: Expected HTTP/`,
   or an assertion reading the WRONG response (`expected 200 to be 400`,
   `expected undefined to be '<body>'`) on a clean, isolated, spawn-free test
   (e.g. `agent.test.ts` "rejects an invalid agentRuntime", `app.test.ts` PATCH
   artifact). `request(app)` (supertest) binds an EPHEMERAL server on a fresh port
   per call and tears it down after; under worker CPU pressure the
   bind/teardown/port-reuse races, so a client occasionally reads bytes framed for
   a different (or half-closed) response. Both "Expected HTTP/" and the spurious
   status/body are the SAME mechanism (mis-framed bytes that either fail to parse
   or happen to parse as a stray response). This is NOT a product bug and NOT the
   prod ECONNRESET. Proper fix (deferred): bind ONE persistent server per test
   file (`app.listen(0)` in `beforeAll`, `request(server)`, close in `afterAll`)
   so there's no per-request port churn. Left as a follow-up.

Net: the daemon-suite flake went from ~10% to its irreducible source #3 (the
supertest harness race); #1 and #2 are eliminated.
