# Follow-ups

---
title: Board freshness perf smoke + stress-count cost measurement
motivation: This run's brief.md ACs 4 and 7 demanded that the `git worktree list` cost be measured at the current count (~3 worktrees) AND a stress count (≥ 10 worktrees), and that `snapshot.build(cfg)` be measured at N=3/10/20 with a ≤100ms median budget. Neither was done — the 3-worktree cost was cited from the originating TODO conversation and the stress count was not measured at all. `build.md`'s post-review AC table now honestly reports this as "Partial / Deferred" (see `review.md` F-001 and F-002). The freshness change here doesn't touch `snapshot.build`'s cost path, so it shouldn't regress; empirical verification is still worth a single session before the next perf-adjacent change accumulates more drift.
suggested_scope: One run that adds `scripts/bench_board_freshness.py` (or inlines a `@pytest.mark.benchmark`-style test in `tests/test_board_freshness.py` if the suite already has the plumbing). The script generates synthetic workbenches at N=3/10/20 worktrees, runs `git worktree list --porcelain` at least 5 trials per N, runs `snapshot.build(cfg)` at least 5 trials per N, prints median + p90 for each, and records results in a checked-in `docs/perf/board-freshness.md` table. In scope: measurement + the table. Out of scope: any tuning of TTL / rescan defaults (separate decision once the data lands); any change to `snapshot.build`'s cost model (covered by TODO §9 separately).
category: scope_extension
---

Bundles two strictly-measurement-only ACs that were honest about being deferred. Treating them as one follow-up because the harness, the synthetic-workbench fixture, and the cost-recording table are identical; splitting would duplicate the setup. Also relates to TODO §9 (the O(N²) snapshot perf TODO) — that work will want exactly the same benchmark harness, so landing this first gives §9 a baseline to compare against.

---
title: Document `_watched_paths` thread-safety contract in lib/board/app.py
motivation: `AgentBoardApp._watched_paths` is mutated only from the Textual UI thread today (both `on_mount` and the `set_interval`-driven `_rescan_worktrees` callback run UI-side; the Observer-thread `_Handler.on_any_event` reads `self._app` only). A future contributor adding an Observer-thread reader to `_watched_paths` (e.g. to short-circuit duplicate event posts) would create a race without realizing it. `review.md` F-005 flagged this as a minor doc nit.
suggested_scope: One small docs-only change. Add a one-line comment next to `self._watched_paths: set[str]` in `AgentBoardApp.__init__` saying "Mutated only from the UI thread; do not read or write from the Observer thread without a lock." Optionally extend the same convention to a module-level "Threading model" paragraph in the file's docstring if other thread-sensitive attributes get added. In scope: the comment(s). Out of scope: any actual locking — the current single-threaded invariant is correct and a lock would only be needed if a real Observer-thread read appeared.
category: docs
---

Cheap. Could ride along with any future change to `lib/board/app.py` rather than getting its own run.

---
title: Replace iter_all_runs in board re-scan with cached worktree-list once §9 lands the snapshot perf refactor
motivation: `_rescan_worktrees` currently iterates `_list_workbench_worktrees(cfg)` (cheap — TTL-cached `git worktree list`). Earlier draft iterated `iter_all_runs`, which would walk every run's metadata.yaml on every 5s tick — `review.md` F-003 documented why we changed away from that. But TODO §9 ("Board snapshot is O(N²) and re-parses every metadata.yaml 3–4× per tick") proposes threading a single resolved `Run` set through `snapshot.build`. Once §9 lands, the board could share that resolved set with the rescan tick, removing the duplicate worktree-list call between `_refresh` (every 1s) and `_rescan_worktrees` (every 5s). Not a problem today; an obvious optimization point once §9 makes it natural.
suggested_scope: Wait for TODO §9 to land. Then a small follow-up that threads the §9-cached run/worktree set into `_rescan_worktrees`. Test: assert that on a typical board tick, `_list_workbench_worktrees` is called at most once per second (or whatever §9's cache shape allows). Out of scope: re-doing §9's caching decisions; touching the TTL machinery here (it stays — short-lived CLI calls still need it).
category: tech_debt
---

This is a "sequential dependency" follow-up — wait for §9 to land before opening this. Filed so it doesn't get lost.
