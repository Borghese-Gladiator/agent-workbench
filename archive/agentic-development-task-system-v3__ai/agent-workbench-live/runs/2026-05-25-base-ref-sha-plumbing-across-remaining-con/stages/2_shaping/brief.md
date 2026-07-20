# Brief

## Goal

Finish the `base_ref_sha` plumbing that commit `303bd40` started. That commit added `target.repo.base_ref_sha` to `metadata.yaml` and taught `lib/metrics/lines.py` to prefer the captured SHA over a symbolic `base_ref` when computing diffs. Four pieces of follow-on work remain:

1. **2a — fix the only consumer that's observably broken today.** `lib/validate_context.py`'s `build` and `build_blast_radius` shell out `git diff <base_ref>...HEAD` against a symbolic `base_ref`. When the recorded `base_ref` is `"HEAD"` (the common case for self-modifying runs), this resolves to "worktree HEAD vs. itself," producing an empty diff. `validate-context.md`'s "Files changed" block then renders `(no files changed yet)` for runs that have real worktree-branch commits, and the reviewer's blast-radius narrative is starved.
2. **2b — close type-signature drift in two other consumers.** `lib/board/source.py:_git_shortstat` and `lib/doc_claims.py:_verify` still take only symbolic `base_ref`. They aren't observably broken in the same way as 2a (the triple-dot diff produces *a* number), but the type contract has drifted away from `lines.py:_effective_ref`. Bring them into symmetry.
3. **2c — backfill `base_ref_sha` into pre-`303bd40` runs.** Without backfill, `agent-workbench metrics --rebuild` against an older run reports `generated_lines: 0` because the lazy in-worktree resolver can't recover the original fork point once HEAD has moved forward.
4. **2d — emit a `BaseRefResolved` audit event.** Today the resolved SHA lives only in `metadata.yaml`. The audit log carries the symbolic ref but not the SHA, so line counts can't be re-derived from the audit log alone and drift between metadata and the original resolution is undetectable.

## User-facing behavior

There is no human-UI surface change. "User" here means the agent and the developer running `agent-workbench`. Observable outcomes:

- After 2a lands, every run started against any `base_ref` (including `"HEAD"`) shows real worktree-branch commits in `validate-context.md`'s "Files changed" block. Today, runs with `base_ref: "HEAD"` show `(no files changed yet)` even after substantive worktree work.
- After 2c lands, running `agent-workbench metrics --rebuild` against a representative pre-fix run (e.g. `2026-05-22-token-efficiency-tracking`) reports a non-zero `generated_lines`. Today it reports zero.
- After 2d lands, new runs' `events.jsonl` contains a `BaseRefResolved` event between the `planning → ready` and `ready → building` transitions, capturing `{symbolic_ref, sha, source_repo_path}`. The rendered `audit.md` surfaces the resolution.
- After 2b lands, no externally visible change. The internal contract is consistent: anyone calling the three diff-emitting helpers passes the SHA when they have it, and the helpers prefer it.

## Acceptance criteria

1. `validate_context.build` and `validate_context.build_blast_radius` accept a `base_ref_sha: str | None = None` kwarg and prefer it over the symbolic `base_ref` when computing the diff. When `base_ref_sha` is `None`, fall back to the existing symbolic-ref lazy-resolve path. Mirror the `lib/metrics/lines.py:_effective_ref` shape.
2. `cmd_validate.py`'s `_write_validate_context_artifacts` reads `meta["target"]["repo"]["base_ref_sha"]` (alongside `base_ref`) from `metadata.yaml` and threads it through the `validate_context.build` / `build_blast_radius` calls.
3. `lib/board/source.py:_git_shortstat` and `lib/doc_claims.py:_verify` accept a `base_ref_sha` kwarg with the same prefer-SHA / lazy-fallback semantics. Their call sites (`lib/board/source.py:566` and the `doc_claims.verify` call in `cmd_validate.py`) pass the SHA through.
4. A new `tools/backfill_base_ref_sha.py` script walks `runs/*/metadata.yaml`, finds entries with symbolic `target.repo.base_ref` and missing `target.repo.base_ref_sha`, computes the fork point (`git merge-base <branch> <default-base-ref>`, falling back to `git rev-list --max-parents=0 <branch>`), and writes the resolved SHA via `metadata.update`. The script is idempotent and supports `--dry-run`.
5. Running the backfill against this workbench then `agent-workbench metrics --rebuild` against `2026-05-22-token-efficiency-tracking` produces a non-zero `generated_lines`.
6. A `BaseRefResolved` event is defined in `schemas/events.jsonl` with payload `{symbolic_ref, sha, source_repo_path}` and is emitted from `cmd_start.py` immediately after `repos.resolve_ref_to_sha` returns successfully, before the `building` transition. `lib/audit.py`'s `audit.md` render surfaces the resolved SHA.
7. New parallel unit tests exist for each touched module: `tests/test_validate_context.py` (or equivalent — see Assumptions) covers the synthetic two-commit-worktree case that would fail before 2a; `tests/test_board_snapshot.py` covers `_git_shortstat`'s SHA path; `tests/test_doc_claims.py` covers `doc_claims.verify`'s SHA path. Each new test fails against today's code and passes after the change.
8. A grep for `base_ref:` in `lib/board/source.py` and `lib/doc_claims.py` finds only calls that also accept `base_ref_sha`.
9. The backfill tool is forward-compatible: no event synthesis for pre-fix runs (i.e. don't retroactively write `BaseRefResolved` to old `events.jsonl` files); metadata-only changes.

## Non-goals

- Changing the `metadata.yaml` schema beyond what `303bd40` already established. The `target.repo.base_ref_sha` field already exists; this run only threads it through more consumers.
- Reworking how `base_ref` itself is captured at `new-run` time. The symbolic-ref capture path is unchanged.
- A new artifact or new lifecycle stage. This run is internal-plumbing only.
- Real-time observability of base-ref drift (e.g. dashboard, alerting). The audit event makes drift detectable; surfacing it beyond `audit.md` is out of scope.
- Schema-level validation of `metadata.yaml` on load. That's [TODO §4](../../docs/TODO.md); this run does not touch `lib/metadata.py`'s validator.
- Backfilling other historical-only fields. Only `base_ref_sha`.
- Building a generalized "ref resolver" abstraction across the three diff-emitting helpers. Each helper keeps its existing call shape, gaining only the kwarg.
- Changing the `gh`/remote story or running anything against external repos. The work is entirely local.
- Touching the `*-context.md` cross-stage contract ([TODO §1](../../docs/TODO.md)). That's a separate run.

## Good examples

- The shape we're mirroring is `lib/metrics/lines.py:_effective_ref` (per the raw idea). The kwarg signature there — `base_ref` plus optional `base_ref_sha`, prefer SHA when present, lazy-resolve symbolic when missing — is the template for 2a and 2b.
- The deterministic + idempotent + `--dry-run` shape of `tools/backfill_completion_refs.py` (mentioned in the raw idea as the analog for merge SHAs) is the template for `tools/backfill_base_ref_sha.py`.
- The `schemas/events.jsonl` event-definition style (alongside existing transition events) is the template for `BaseRefResolved`.

## Bad examples

- **Don't** introduce a new "resolver" class or module to unify the three call sites. Three sites passing a kwarg is fine; an abstraction layer is not justified by the surface area.
- **Don't** make the backfill script destructive in any default mode. Idempotent and dry-run-supported is the requirement; in-place YAML rewrites must use `metadata.update` (not raw file writes) so loader invariants hold.
- **Don't** synthesize historical `BaseRefResolved` events into old `events.jsonl` files. Audit logs are forward-only.
- **Don't** change `target.repo.base_ref_sha`'s on-disk shape (still a string field on the existing key path). No nested objects, no rename.
- **Don't** quietly change which helpers shell out git differently. Each helper keeps its existing diff command (`git diff <ref>...HEAD` for validate_context, etc.) — only the source of `<ref>` changes.
- **Don't** add a CLI surface for the backfill beyond `--dry-run`. No interactive prompts, no verbose flag set, no JSON output mode. Keep it small.

## Constraints

- Python only. The workbench is Python; no shell-script ports of any of the four work items.
- All git invocations stay subprocess-based and stay scoped to the worktree path the helper already operates on. The raw idea confirmed the diff target is the worktree (it already is).
- Unit tests use the synthetic-fixture style already established in `tests/` (e.g. `_make_self_modifying_workbench`, two-commit worktrees). No real-repo integration tests for these four items.
- The backfill script lives at `tools/backfill_base_ref_sha.py`, parallel to `tools/backfill_completion_refs.py`. No new top-level CLI subcommand on `agent-workbench`.
- The `BaseRefResolved` event must not break existing audit consumers. If `lib/audit.py` has any switch-on-event-kind logic, the new kind must be handled with a default branch that doesn't crash on the new payload.
- The four pieces (2a, 2b, 2c, 2d) can land in any order, but 2c (the backfill) only proves out after 2a is in place — because the acceptance test for 2c is observing non-zero `generated_lines` from `metrics --rebuild`, which exercises `_effective_ref` from `lines.py`, not the new validate_context plumbing. Practically, land 2a first, then 2b alongside or after, then 2d, then 2c last — or land all in one PR and verify acceptance end-to-end.

## Assumptions

- The pre-fix run `2026-05-22-token-efficiency-tracking` is still present in `runs/` and still has the originally-captured `base_ref: "HEAD"` (no manual edits). If it's been modified, the backfill acceptance check needs to find another similarly-stale run.
- `lib/metrics/lines.py:_effective_ref` exists with the shape the raw idea describes (prefer-SHA / lazy-resolve / fallback). The planning stage will confirm exact signature.
- `repos.resolve_ref_to_sha` is callable from `cmd_start.py` and is the right hook point for emitting `BaseRefResolved`. The raw idea names it explicitly.
- `metadata.update` is the canonical mutator for `metadata.yaml` (per the raw idea's instruction to use it in the backfill script).
- The default base ref for `git merge-base` in the backfill is read from `agent-workbench.yaml`. If the yaml doesn't expose it cleanly, the planner may decide to take it from the loaded config object instead.
- `lib/audit.py` has an existing render path for `audit.md` that this run can extend without inventing a new section convention. If the render is opinionated about event ordering, `BaseRefResolved` slots in near the transition events.
- `schemas/events.jsonl` is a record-per-line schema file (or schema fragments file). The planner will confirm whether new event kinds are added as JSON objects or markdown tables; this run will mirror what's there.
- No external systems consume `events.jsonl` directly. A new event kind doesn't break a downstream contract.
- No new dependencies are needed. All work is in stdlib + `pyyaml` + `subprocess` territory.
- The new tests are unit tests, not integration tests; they don't run the live workbench end-to-end.
- `cmd_validate.py:_write_validate_context_artifacts` already loads `meta` from `metadata.yaml` and just needs the extra key read; if not, the planner adds a load.

## Suggested QA scenarios

1. **2a regression test on a self-modifying-style worktree.** Create a synthetic workbench with a two-commit worktree branch where `base_ref` is recorded as `"HEAD"` and `base_ref_sha` carries the actual fork point. Call `validate_context.build` and assert "Files changed" lists both commits' files. Repeat without `base_ref_sha` set — the file should fall back to lazy-resolve and produce the same answer if the symbolic ref is recoverable in this fixture, else an empty/sentinel value (whichever today's behavior is).
2. **2b symmetry tests.** Repeat the 2a fixture against `_git_shortstat` (assert the int return is non-zero) and `doc_claims.verify` (assert it doesn't crash and emits the expected verification record). Drop the SHA, confirm fallback path executes.
3. **2c backfill happy path.** On a synthetic workbench with one run lacking `base_ref_sha` and one run already populated, run the backfill in `--dry-run` mode — assert the dry-run reports one would-be-changed run and zero changes on the second. Run without `--dry-run` and assert the first run's `metadata.yaml` gains a `base_ref_sha` value matching `git merge-base` output; second run is byte-identical.
4. **2c idempotency.** Run the backfill twice in a row against the synthetic workbench. Second run reports zero changes and exits 0.
5. **2c degenerate fork point.** Create a synthetic branch whose `git merge-base` fails (orphan branch). Run the backfill — assert it falls back to `git rev-list --max-parents=0` and writes that SHA.
6. **2c real-repo dogfood.** Run the backfill against the live workbench, then run `agent-workbench metrics --rebuild` against `2026-05-22-token-efficiency-tracking`. Assert `generated_lines` is non-zero in the rebuilt metrics row.
7. **2d audit event on a fresh run.** Start a new (`/start`) run in a synthetic workbench. Inspect `events.jsonl` — assert one `BaseRefResolved` event appears between the `planning → ready` and `ready → building` lines, with the three payload fields populated. Inspect rendered `audit.md` — assert the resolved SHA appears.
8. **2d backward compatibility.** Replay an old `events.jsonl` (no `BaseRefResolved`) through `lib/audit.py`'s render. Assert no exception; assert the rendered `audit.md` reads sensibly without the event.
9. **Combined end-to-end.** Drive `/shape → /plan → /start → /validate` on a synthetic self-modifying run after all four changes are in. Confirm: `events.jsonl` has the new event; `validate-context.md` shows real changed files; the `_write_validate_context_artifacts` path didn't crash on the new kwarg.
10. **Grep audit.** From the workbench root, `grep -n 'base_ref' lib/board/source.py lib/doc_claims.py` — every match referring to the kwarg also names `base_ref_sha` somewhere on the same call.
