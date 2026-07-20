# LOG

**05/05**
- Built ai-workbench MVP: standalone control-plane repo orchestrating AI-assisted dev across multiple local product repos. All planning artifacts centralized; product repos stay clean.
- Created top-level structure: `config/`, `docs/`, `ideas/raw|normalized/`, `runs/`, `worktrees/`, `templates/`, `scripts/`, `lib/`.
- Wrote `README.md` covering control-plane architecture, run lifecycle, worktree strategy, artifact map, branching model, centralized-AI-memory philosophy, and an "Agent Operating Rules" section.
- Wrote `docs/architecture.md` (why centralized, why worktrees, why metadata canonical, why Python-not-bash for parsing), `docs/lifecycle.md` (status state machine + transitions), `docs/beads-integration.md` (future Beads story without polluting product repos).
- Added `config/repos.yaml.example` with absolute-path-only registry format.
- Added `.gitignore` for OS/editor/Python cruft; explicitly does NOT ignore `runs/`, `worktrees/`, or markdown.
- Wrote 8 templates: `raw-idea.md`, `normalized-feature-input.md`, `spec.md`, `run-log.md`, `decisions.md`, `qa-log.md`, `pr-summary.md`, `metadata.yaml`.
- Wrote 3 Python helpers in `lib/` (stdlib-only, no PyYAML/yq):
  - `paths.py` — centralized path resolution from workbench root.
  - `_yaml.py` — minimal flat-or-one-level-nested YAML reader/writer for our schema subset; rejects unsupported shapes loudly.
  - `repo_config.py` — load + validate `repos.yaml`; checks abs paths, github slug shape, on-disk repo existence.
  - `metadata.py` — `Metadata` dataclass; `new_metadata()`, `save()`, `load()`, `transition()`, `generate_run_id()` with same-day collision auto-increment.
- Wrote 8 shell scripts (all `set -euo pipefail`, safe quoting, fail loud):
  - `init-repo.sh` — bootstrap dirs, git init if needed, copy example config, run validator.
  - `new-feature.sh <repo_key> <slug> "<idea>"` — generate run_id, create run dir, copy templates, render `metadata.yaml`. Does NOT touch product repo.
  - `create-worktree.sh <run_dir>` — validate repo + default branch, create worktree at `worktrees/<run_id>/` on branch `ai/<run_id>`, transition status to `in_progress`. Idempotent; refuses to overwrite mismatched state.
  - `complete-run.sh <run_dir> [--abandon] [--remove-worktree] [--delete-branch] [--force]` — flip status to `merged` or `abandoned`, optional cleanup. Run artifacts always preserved.
  - `qa-pass.sh <run_dir> [-r result] [-t tester] [-s scope] [-n notes]` — append QA-N entry to `qa-log.md` with auto-incremented ordinal and worktree HEAD SHA; status → `qa`.
  - `pr-summary.sh <run_dir>` — print run's `pr-summary.md` plus a pre-filled `gh pr create` command.
  - `validate-workbench.sh` — sanity-check tooling, dirs, templates, lib imports, config parse, repo paths on disk, per-run metadata parse.
  - `validate-product-repos-clean.sh` — scan configured repos for forbidden orchestration dirs (`/specs`, `/runs`, `/ai`, `/beads`, `/logs`); fail with exit 1 on any hit.
- End-to-end verified the MVP against a throwaway product repo: init → validate → `new-feature` (twice, second auto-incremented to `-002`) → `create-worktree` → idempotent re-run → `qa-pass` → `pr-summary` → `validate-product-repos-clean` (negative + positive) → `complete-run --remove-worktree --delete-branch` → terminal-status protection (rejects re-completion of `merged`) → `complete-run --abandon` from `draft`.
- Caught and fixed bug: `init-repo.sh` checked `[[ ! -d ".git" ]]`, which is true inside a worktree (where `.git` is a *file*); running inside this worktree created an inert nested repo that overshadowed the worktree's `.git` link. Replaced with `git rev-parse --is-inside-work-tree`, which correctly handles regular repos, worktrees, and subdirs of either. Restored worktree by deleting the empty nested `.git`.

- Added `gh` (GitHub CLI) integration as an optional dependency.
- Extended `Metadata` dataclass and `templates/metadata.yaml` with 4 new fields: `pr_url`, `pr_number`, `remote_name` (default `"origin"`), `github_cli_required` (default `"false"`).
- Wrote `scripts/open-pr.sh <run_dir> [--remote NAME] [--no-push]` — preflights gh + auth, validates worktree-on-expected-branch, refuses no-commits-ahead branches, refuses missing remote with actionable message, `git push -u`, `gh pr create --draft` with body from `pr-summary.md`, parses `pr_url` + `pr_number`, persists to metadata, prepends a `> **PR:** <url>` banner to `pr-summary.md`, transitions status → `in_review`. Idempotent: re-runs with `pr_url` already set print the existing PR and exit 0.
- Wrote `scripts/check-pr.sh <run_dir>` — calls `gh pr view --json state,mergeable,isDraft,statusCheckRollup,reviews,reviewDecision,comments,headRefName,baseRefName,url`; formats a summary (success/failure/pending check counts, failing-check names with details URLs, recent review notes, unresolved comments) via stdlib `json` (no jq); appends timestamped entry to `run-log.md`. Does NOT change status — CI loop is human-driven.
- Extended `validate-workbench.sh`: new `[gh]` line in `[tooling]` reporting version + auth status; warns when `gh` missing; escalates to a hard failure when any run has `github_cli_required: "true"` and `gh` is absent.
- Extended `README.md` with "GitHub CLI integration (optional)" section: `gh auth login` prerequisite, `open-pr.sh` workflow, CI-fix loop with `check-pr.sh`, per-run opt-in flag.
- End-to-end verified the gh integration: fresh metadata contains all 4 new fields with defaults; `validate-workbench.sh` reports `gh: ... (authenticated)`; warns (exit 0) when gh missing without required flag; fails (exit 1) when gh missing with `github_cli_required: "true"` (verified by hiding gh on `PATH`); `open-pr.sh` rejects no-commits-ahead branches; rejects missing `origin` remote; idempotent when `pr_url` already set; `check-pr.sh` against non-existent GitHub repo surfaces upstream gh GraphQL error and leaves `run-log.md` untouched.
- Caught and fixed bug: `check-pr.sh`'s status-check classifier only read `conclusion`/`state`, missing the in-flight CheckRun shape (`status: IN_PROGRESS`). Verified against synthetic gh JSON; fixed to read `conclusion || status || state` with correct precedence.
- Did NOT exercise: actual `gh pr create` API call against a real GitHub remote — throwaway test repo had no remote and pushing to a real repo wasn't authorized. Trusts upstream gh past the preflight boundary.

---

**05/06 — Comparison: current ai-workbench vs. proposed "Enterprise GitHub PR Agent"**

## TL;DR

Current `ai-workbench` and the proposed architecture are **complementary, not competing**:

- **`ai-workbench` is a control plane / substrate.** It stores planning artifacts, orchestrates runs, manages worktrees and branches, and shells out to `gh` for PR creation. It deliberately does **not** embed an agent (`docs/architecture.md:96`: *"ai-workbench is the substrate for agent work, not the agent."*).
- **The proposed design is an agent runtime.** A *sequential pipeline* of specialist phases (Repo Reader → Planner → Coder → Test Runner → Failure Diagnoser → Diff Reviewer → PR Creator) with typed I/O contracts, retry policies, and bounded autonomy.

Natural integration: the proposed pipeline could **run inside** an `ai-workbench` worktree, using `runs/<run_id>/` artifacts as durable memory and the workbench scripts (`create-worktree.sh`, `open-pr.sh`, `check-pr.sh`) as the side-effecting boundary.

## Phase mapping

| Proposed phase                | Covered by current setup?                                                   | Where                                                                             |
|-------------------------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| 1. Understand task            | **Partial (artifact only).** `raw-idea.md` + `normalized-feature-input.md` capture intent; no agent logic to extract it. | `templates/raw-idea.md`, `templates/normalized-feature-input.md`, `scripts/new-feature.sh` |
| 2. Inspect repository         | **No.** No "Repo Reader" phase. User/agent does it manually inside the worktree. | —                                                                                 |
| 3. Build repo/context map     | **No.** No mapping artifact. (Would naturally live in `runs/<id>/repo-map.md`.) | —                                                                                 |
| 4. Propose implementation plan | **Yes (artifact only).** `spec.md` is the contract. Author is human or external agent. | `templates/spec.md`                                                                |
| 5. Approval gate              | **Implicit.** `draft → planned` is a manual `metadata.yaml` edit. No automated risk classifier or escalation rule. | `docs/lifecycle.md`, `lib/metadata.py:transition()`                                |
| 6. Create branch              | **Yes.** Worktree + branch creation is one script, idempotent, refuses unsafe overwrites. | `scripts/create-worktree.sh`                                                       |
| 7. Edit code                  | **No.** Out of scope. Workbench provides the worktree but does not edit.    | —                                                                                 |
| 8. Run tests / lint / build   | **No.** No "Test Runner" phase. No discovery of repo-specific test commands. | —                                                                                 |
| 9. Diagnose & fix failures    | **No.** No retry budget, no diagnoser.                                       | —                                                                                 |
| 10. Adversarial diff review   | **No.** No phase, no artifact.                                               | —                                                                                 |
| 11. Generate PR title + body  | **Partial.** `pr-summary.md` template (Title/Why/What/Tested/Risk) + `pr-summary.sh` to print it. Body authored by human/agent. | `templates/pr-summary.md`, `scripts/pr-summary.sh`                                 |
| 12. Push branch               | **Yes.** `git push -u <remote> <branch>` with preflight (no commits ahead → fail; missing remote → fail). | `scripts/open-pr.sh:134-141`                                                       |
| 13. Open PR                   | **Yes (draft only).** `gh pr create --draft`. Idempotent on `pr_url`.       | `scripts/open-pr.sh:152-207`                                                       |
| 14. Final summary to user     | **Partial.** `open-pr.sh` prints PR URL/number/status; `check-pr.sh` summarizes CI/review. No "files changed / risks / reviewer focus" synthesis. | `scripts/open-pr.sh:209-217`, `scripts/check-pr.sh`                                |

## Cross-cutting concerns

| Concern                    | Proposed design                                                  | Current ai-workbench                                                                                                                               |
|---------------------------|-------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| **Architecture**           | Sequential controller with typed phase contracts.                | Lifecycle state machine (`draft → planned → in_progress → in_review → qa → merged`) + bash. Status is the only structured handoff. |
| **Audit trail**            | "Log every command and file mutation."                           | `run-log.md` (append-only) + `decisions.md` (ADRs) + `qa-log.md` + `metadata.yaml`. Human/agent appends manually; no automatic command logging.    |
| **Approval gates**         | Explicit list (large refactors, deps, migrations, infra, CI/CD, auth, deletions, generated files, broad formatting, push). | One implicit gate: `draft → planned` requires manual edit. No risk classifier; nothing automatically blocks "broad" or "risky" changes. |
| **Retry policy**           | At most 3 fix cycles; summarize per cycle.                       | None. CI-fix loop is human-driven; `check-pr.sh` snapshots state but doesn't retry.                                                                |
| **Bounded autonomy**       | Allowlist + denylist (no merge/deploy/secret-rotation/self-approve/test-bypass). | Implicit through script surface area: workbench scripts can't merge, can't deploy, can't rotate secrets, can't push to default branch. PRs always opened as `--draft`. |
| **Sandboxing**             | "Sandboxed execution; scoped GitHub credentials."                | Worktree isolation prevents trampling the user's main checkout; uses ambient `gh` auth (not scoped per run). No command sandbox.                   |
| **Branch safety**          | Never push to default; always feature branch.                    | Branch hardcoded `ai/<run_id>`; `open-pr.sh` validates `current_branch == metadata.branch_name` before pushing.                                     |
| **Idempotency**            | Implicit (controller can re-enter phases).                       | Explicit and well-tested: `create-worktree.sh` and `open-pr.sh` short-circuit when state already matches.                                          |
| **Data model**             | "Typed input/output contract" per phase.                         | `Metadata` dataclass (`lib/metadata.py:39`) is the only typed contract; everything else is markdown.                                                |
| **Persistence philosophy** | Audit trail.                                                     | "Centralized AI memory" — `runs/` as a queryable corpus of "what we built, why, what broke" (`README.md:163-175`).                                  |
| **PR description content** | Problem / Solution / Files changed / Validation / Risks / Screenshots / Follow-up. | Title / Why / What changed / How tested / Risk-rollout / Linked artifacts / Checklist. Roughly aligned; proposal explicitly adds *files-changed* and *follow-up*. |
| **Final response format**  | PR link, branch, commit, summary, tests, failures, risks, reviewer focus. | `open-pr.sh` prints PR URL/number/status; deeper synthesis must be assembled from `decisions.md` + `qa-log.md` by the agent.                       |

## What current setup has that the proposal does not

1. **Multi-repo control plane.** `config/repos.yaml` registers many product repos; each run targets one. The proposal is single-repo by default.
2. **Worktree-based isolation.** Concurrent runs against the same repo are safe.
3. **Decoupled planning artifacts.** Specs/decisions/QA logs live in `runs/`, never in the product repo. `validate-product-repos-clean.sh` enforces this.
4. **Lifecycle state machine.** Seven well-defined states with terminal-status protection (`lib/metadata.py:199`).
5. **QA-pass concept.** `qa-pass.sh` records ordinal + build SHA + result + tester.
6. **Idempotency baked in** for the side-effecting scripts.
7. **Append-only memory discipline** for `run-log.md`, `decisions.md`, `qa-log.md` (`README.md:171`).

## What the proposal has that the current setup does not

1. **An actual agent.** Workbench has no inspection / planning / coding / testing / reviewing phases. Bring-your-own.
2. **Specialist roles with typed I/O.** No `Planner`, `Coder`, `Test Runner`, `Failure Diagnoser`, `Diff Reviewer`, `PR Creator` code.
3. **Risk classifier / approval-gate machinery.** No automated check for large refactors / dep changes / migrations / infra / CI/CD / auth / deletions / generated files / broad formatting.
4. **Bounded retry loop.** No 3-cycle test/fix budget; CI fixes are human-driven.
5. **Adversarial diff review.** No equivalent. `pr-summary.md` is descriptive, not adversarial.
6. **Repo context map.** No `repo-map.md` artifact.
7. **Scoped GitHub credentials.** Uses ambient `gh auth`.
8. **Per-command logging.** `run-log.md` is human-curated.
9. **Files-changed / commit-hash / reviewer-focus** in the final summary.

## Gap list (smallest → largest)

1. **`repo-map.md` template + `inspect-repo.sh`.** Walk the product repo for languages, manifests, test/lint/build commands, ownership hints. Cheap.
2. **`diff-review.md` template + `review-diff.sh`.** Run `git diff <default>..<branch>`, format for adversarial review. Append findings to a new `review-log.md` (or `decisions.md`).
3. **Extend `pr-summary.md`** with auto-filled *Files changed* (from `git diff --name-only`) and *Follow-up work* sections. ~20 lines of script + template edit.
4. **Risk classifier (`classify-change.sh`).** Flag dep-manifest changes, migration files, CI config changes, auth-adjacent paths, file deletions, generated-file edits, large diffs (>N files / >M lines). Emit triggered gates; agent must acknowledge before pushing.
5. **Bounded retry helpers.** `run-validation.sh <run_dir>` discovers test/lint/build commands and writes structured `validation-N.md`. Pair with `fix-cycle.sh` capped at 3 iterations, each producing a diff + summary.
6. **Auto-generated final summary (`summarize-run.sh`).** Stitch PR URL + branch + latest commit SHA + files changed + tests run + decisions + QA result + residual risks + reviewer focus.
7. **Embed an agent driver under `lib/agent/`.** Run the proposed sequential pipeline against a `<run_dir>`, writing each phase's output as a typed artifact. Largest addition — brings the proposed runtime *inside* the workbench while keeping the workbench's "memory + side-effects" boundary intact.

## Architectural take

The proposal's core insight: *"sequential pipeline with specialist phases beats free-form swarm"* — a runtime concern.
The workbench's core insight: *"keep planning artifacts out of product repos; treat `metadata.yaml` as canonical"* — an artifact / orchestration concern.

These are orthogonal. Folding the proposed pipeline into the workbench yields:
- The pipeline's typed-phase clarity for *what the agent does*.
- The workbench's run/worktree/artifact discipline for *how the work is remembered and where the side effects land*.

Risky path: reimplementing the workbench's lifecycle inside the proposed pipeline (or vice versa). Both already exist; treat them as separate layers.

## Suggested next steps if pursuing alignment

- **Phase 1 (low cost, high signal):** items 1–3. `inspect-repo.sh`, `review-diff.sh`, richer `pr-summary.md`. No new runtime concepts.
- **Phase 2 (mid cost):** items 4 + 6. Risk classifier + auto-summary. Introduces *automated approval gate* and *final response format*.
- **Phase 3 (high cost):** items 5 + 7. Retry loop + embedded agent driver. Workbench stops being purely a substrate and becomes an agent harness.

Phase 1 alone is enough to make the workbench a more opinionated PR-oriented harness without changing its philosophy. Phases 2–3 are the actual port of the proposed architecture.

---

**05/11 — `/draft-pr` end-to-end validated against tempdir harness**

Stood up `/tmp/draft-pr-test/product-repo` as a throwaway git repo, pointed a temporary `repos.yaml` at it, ran `new-feature.sh` + `create-worktree.sh` + one feature commit, populated all four artifacts, then ran the `/draft-pr` Bash block. End-to-end pass:
- `find_workbench_root` walked up correctly from CWD.
- `lib/run.py` resolved the relative `runs/<id>` path and loaded metadata cleanly.
- `git diff --stat main...HEAD` produced expected output (2 files, 14+/1−); appended to `run-log.md` with UTC timestamp and proper fencing.
- Bash exports (`RUN_ID`, `RUN_DIR`, `WORKTREE`, `BRANCH`) all usable downstream.
- Stitching `pr-summary.md` from spec + decisions + qa-log + run-log was unambiguous following the section→artifact mapping in the slash-command markdown.

Cleaned up via `complete-run.sh --abandon --remove-worktree --delete-branch --force`; tempdir + run dir removed; `repos.yaml` restored from backup.

---

**05/13 — Plan: orchestrator gaps (Moves 1-3 from design comparison)**

## Brief

The README's lifecycle (`draft → normalize → brainstorm → ready → in_progress → in_review → qa → merged | abandoned`) is *documented* but only the back half (`in_progress → merged`) is *enforced*. Compared against the "AI Orchestrator from scratch on Claude Code" design options, four gaps stand out:

1. **State machine has no evidence requirements.** `lib.metadata.transition()` validates the `(from, to)` pair and the investigation/terminal guards, but `qa → merged` doesn't require `tests_passed=true` or `pr_url` to be set. Every status flip is "trust me." Compare: the options doc's transition table where each edge requires structured evidence.
2. **No event log.** `run-log.md` is prose. We can't query "which runs failed review twice this month" or replay state. The options doc's `task_events` append-only stream is the missing piece. `metadata.yaml` could become a projection of the event log.
3. **Front half of lifecycle is undocumented in code.** `normalize` and `brainstorm` exist as words in the README but have no slash command, no template, and no transition. The "spec written by hand" step is exactly where AI orchestration would help most.
4. **(Out of scope for now)** Stage workers aren't uniform — mix of shell and slash commands, no per-stage retry/timeout/permissions policy. Workable today; revisit when the front half is in place.

This plan addresses Moves 1, 2, and 3. **This session implements Moves 1 and 2.** Move 3 is filed as a follow-up.

`metadata.yaml` stays canonical. `bd` stays optional. The 12 lifecycle scripts and 3 slash commands keep working — both changes are additive.

---

## Move 1 — Deterministic state machine with required evidence

### Goal

Every status transition that crosses a meaningful gate must produce structured evidence, validated at transition time. Manual `sed`-the-yaml status flips remain possible but `validate-workbench.sh` flags any state whose evidence is missing.

### Design

New module `lib/transitions.py` (stdlib-only) with:

```python
@dataclass(frozen=True)
class TransitionEvidence:
    # required keys per (from, to) edge, e.g. qa → merged requires
    # tests_passed, pr_url, review_decision.
    keys: tuple[str, ...]

EVIDENCE: dict[tuple[str, str], TransitionEvidence] = {
    ("draft", "normalize"):     TransitionEvidence(keys=()),
    ("normalize", "brainstorm"): TransitionEvidence(keys=("normalized_spec_path",)),
    ("brainstorm", "ready"):    TransitionEvidence(keys=("approved_by",)),
    ("ready", "in_progress"):   TransitionEvidence(keys=("worktree_path", "branch_name")),
    ("in_progress", "in_review"): TransitionEvidence(keys=("pr_url",)),
    ("in_review", "qa"):        TransitionEvidence(keys=("review_decision",)),
    ("qa", "merged"):           TransitionEvidence(keys=("tests_passed", "pr_url", "merge_sha")),
    # investigation branch
    ("draft", "planned"):       TransitionEvidence(keys=("spec_path",)),
    ("planned", "investigating"): TransitionEvidence(keys=("worktree_path",)),
    ("investigating", "investigated"): TransitionEvidence(keys=("wbs_children",)),
    ("investigated", "merged"): TransitionEvidence(keys=("children_complete",)),
    # any non-terminal → abandoned takes a reason
    ("*", "abandoned"):         TransitionEvidence(keys=("abandoned_reason",)),
}

def transition_with_evidence(
    md: Metadata, new_status: str, evidence: dict[str, str]
) -> tuple[Metadata, dict[str, str]]:
    """Validate edge + evidence, return (new metadata, normalized evidence).
    Raises TransitionError on missing or empty evidence keys."""
```

Notes:
- Two **new** statuses are added: `normalize`, `brainstorm`, `ready` (status enum gains three values). `planned` stays — it's an alias for `ready` on the legacy path until callers migrate. Document the mapping in `docs/lifecycle.md` and gate the new statuses behind validation.
- Evidence is just a flat `dict[str, str]` — same shape as `metadata.yaml` fields. Empty strings count as missing.
- `lib.metadata.transition()` keeps working (no evidence required) for legacy callers and tests; new code should call `transition_with_evidence`. Phase 2 (later) deprecates the old signature.
- `("*", "abandoned")` is a wildcard edge — applies from any non-terminal `from` state. Encoded as a special-cased lookup, not a literal tuple key.

### Tests

`tests/test_transitions.py`:
- Every documented edge round-trips (good evidence → no raise; missing key → `TransitionError`; empty value → `TransitionError`).
- Unknown edges rejected (`("draft", "merged")` should raise).
- Wildcard abandon edge accepts from any non-terminal status, rejects from `merged`.
- Evidence dict is returned with only the documented keys, so callers can serialize it directly to the event log without leaking extras.

---

## Move 2 — Append-only event log per run

### Goal

Every state transition, every artifact write, every meaningful action gets one JSON line in `runs/<run_id>/events.jsonl`. Cheap to write, easy to grep, replayable.

### Design

New module `lib/events.py` (stdlib-only):

```python
@dataclass(frozen=True)
class Event:
    event_type: str         # "TransitionRequested" | "TransitionApplied" |
                            # "ArtifactWritten" | "ReviewVerdict" | ... (open set)
    actor: str              # "human" | "script:<name>" | "slash:<name>" | "agent:<name>"
    from_state: str = ""
    to_state: str = ""
    payload: dict = field(default_factory=dict)
    # created_at filled by append()

def append(run_dir: Path, event: Event) -> None:
    """Append one JSON line to runs/<run_id>/events.jsonl. Atomic via O_APPEND."""

def read_all(run_dir: Path) -> list[Event]:
    """Read every event for a run; useful for `wb events <run_id>` and validators."""

def last_transition(run_dir: Path) -> Event | None:
    """Convenience: latest applied transition. Used by validate-workbench.sh."""
```

Wire-up (this session):
- `lib.metadata.save()` does **not** auto-emit events — that would couple every test that calls save() to a writable disk. Instead, every script/slash command that mutates state calls `events.append()` explicitly after the save.
- Update the four scripts that change status today:
  - `scripts/new-feature.sh` → emit `TaskCreated` event on draft creation.
  - `scripts/create-worktree.sh` → emit `TransitionApplied` on `* → in_progress`.
  - `scripts/qa-pass.sh` → emit `QAVerdict` + `TransitionApplied` on `* → qa`.
  - `scripts/complete-run.sh` → emit `TransitionApplied` on `* → merged|abandoned`.
  - `scripts/open-pr.sh` → emit `PROpened` + `TransitionApplied` on `* → in_review`.
- Each shell script invokes `python3 -c "from lib.events import ..."` (same pattern as existing scripts that touch metadata). One ~6-line bash helper at the top of each script.
- `validate-workbench.sh` gains a check: every run with `status != "draft"` must have at least one event in `events.jsonl`, and the latest `TransitionApplied` event's `to_state` must equal the current `status`. Loud failure if metadata and event-log disagree.

### Schema

```jsonl
{"created_at": "2026-05-13T20:11:43Z", "event_type": "TaskCreated", "actor": "script:new-feature.sh", "from_state": "", "to_state": "draft", "payload": {"repo_key": "frontend", "feature_slug": "foo"}}
{"created_at": "2026-05-13T20:14:02Z", "event_type": "TransitionApplied", "actor": "script:create-worktree.sh", "from_state": "draft", "to_state": "in_progress", "payload": {"worktree_path": "/Users/.../worktrees/2026-05-13-foo-001", "branch_name": "ai/2026-05-13-foo-001"}}
{"created_at": "2026-05-13T20:30:11Z", "event_type": "ArtifactWritten", "actor": "slash:draft-pr", "from_state": "", "to_state": "", "payload": {"path": "runs/2026-05-13-foo-001/pr-summary.md", "bytes": 1842}}
```

### Tests

`tests/test_events.py`:
- `append` + `read_all` round-trip.
- Two concurrent `append` calls in different processes both land (POSIX `O_APPEND` is atomic for small writes; we'll test the contract).
- `last_transition` returns the most recent `TransitionApplied` event, ignoring non-transition events.
- `read_all` on a missing file returns `[]` (so freshly-created runs don't fault).
- Bad event lines (truncated JSON) raise loudly rather than silently skip.

---

## Move 3 — Front half of lifecycle (DEFERRED to follow-up)

Add `/normalize` and `/brainstorm` slash commands so `draft → normalize → brainstorm → ready` is automated by Claude Code instead of "edit metadata.yaml by hand." Same shape as `/ingest-linear`. Filed as a separate plan item once Moves 1+2 land.

---

## Order of implementation (this session)

1. **`lib/events.py` + `tests/test_events.py`.** Smallest unit; no dependencies on transitions.
2. **`lib/transitions.py` + `tests/test_transitions.py`.** Uses lib.metadata's status enum but doesn't modify it.
3. **Extend `VALID_STATUSES`** in `lib/metadata.py` with `normalize`, `brainstorm`, `ready`. Update existing tests if any pin the tuple length.
4. **Wire `events.append()` into the 5 scripts** listed above. One bash helper per script.
5. **Extend `validate-workbench.sh`** with the metadata-vs-event-log consistency check.
6. **Run `python3 -m unittest discover tests`** + `./scripts/validate-workbench.sh` to confirm nothing regresses.

Move 3 (slash commands + new templates) is intentionally NOT in this session's scope.

### What this leaves alone (and why)

- `lib.metadata.transition()` keeps its current signature. New code uses `transition_with_evidence()`. Cheaper than rewriting every existing call site in one PR.
- The investigation branch (`planned → investigating → investigated`) keeps working. Evidence requirements added in the table above but the path itself is unchanged.
- Beads sync stays one-way. The event log lives next to `metadata.yaml`, not in `bd`.
- No new CLI. Scripts call into `lib/` the same way they do today.

---

**05/13 (cont) — Plan: Move 3 — wire the event log into the lifecycle scripts**

Committed Moves 1 + 2 as `4162164`. `lib/events.py` and `lib/transitions.py` are infrastructure that nothing calls yet. Move 3 activates them: every script that flips status today gets a single `events.append()` call, and `validate-workbench.sh` gains a consistency check that fails when `metadata.yaml` and `events.jsonl` disagree.

## Brief

Five scripts mutate run state today: `new-feature.sh`, `create-worktree.sh`, `qa-pass.sh`, `complete-run.sh`, `open-pr.sh`. Each one already has a trailing `python3 -` block that loads `Metadata`, calls `transition()`, and `save()`s — that's the natural place to also emit a `TransitionApplied` event. Adding it is a ~6-line append per script, no new shell logic.

Then `validate-workbench.sh` gains one new check per run: if `events.jsonl` exists, its most recent `TransitionApplied.to_state` must equal `metadata.status`. Mismatch is a hard failure (loud is the point).

The wiring is **best-effort, never blocks the script**. If the event-log write fails (disk full, permission, whatever), the script prints a warning and continues — the same posture the existing Beads sync uses. Status-mutation in `metadata.yaml` is the canonical record; events.jsonl is the audit trail, not a gate. (This also keeps the change low-risk: even if the wiring is buggy, no run gets stuck.)

## Scope

**In:**
- Five scripts get a `events.append()` call after their existing status-flip Python block.
- One `Event` payload per script with the relevant context (e.g. `qa-pass.sh` records `result`, `tester`, `scope`).
- `validate-workbench.sh` gets one new per-run consistency check.
- Unit test for the validator's new check, using a tempdir harness.
- One end-to-end test against a throwaway product repo (same harness style as the 05/11 `/draft-pr` test): create a run, run through `create-worktree → qa-pass → complete-run`, confirm `events.jsonl` contains three `TransitionApplied` events plus the `TaskCreated`, and that `validate-workbench.sh` reports clean.

**Out:**
- Touching `check-pr.sh`. It doesn't change status; it just refreshes the run-log.
- Touching `spawn-children.sh` or `sync-to-beads.sh`. Neither flips status on the parent.
- Touching the three slash commands (`/ingest-linear`, `/review-run`, `/draft-pr`). They invoke the scripts above; the scripts will emit the events. (If a slash command grew its own status flip later, that's when we'd wire it.)
- The `transition_with_evidence()` migration. This pass keeps using `transition()` (no evidence required) — Move 4 (slash commands + spec workflow) is the right place to tighten this. Wiring scripts to require evidence first means rewriting every existing call site for no immediate user-facing benefit.

## Events emitted per script

| Script              | Event(s)                                                    | `to_state`     | `payload`                                                                          |
|---------------------|-------------------------------------------------------------|----------------|------------------------------------------------------------------------------------|
| `new-feature.sh`    | `TaskCreated`                                               | `draft`        | `{repo_key, feature_slug, run_id}`                                                  |
| `create-worktree.sh`| `TransitionApplied`                                         | `in_progress`  | `{worktree_path, branch_name, default_branch, base_sha}`                            |
| `qa-pass.sh`        | `QAVerdict` + `TransitionApplied`                           | `qa`           | (QAVerdict: `{ordinal, result, tester, scope, build_info}`) — TransitionApplied has just the to_state delta |
| `open-pr.sh`        | `PROpened` + `TransitionApplied`                            | `in_review`    | (PROpened: `{pr_url, pr_number, remote_name}`) — TransitionApplied: empty payload  |
| `complete-run.sh`   | `TransitionApplied`                                         | `merged` or `abandoned` | `{remove_worktree, delete_branch, force}` for context                       |

Two scripts (`qa-pass.sh`, `open-pr.sh`) emit two events because the *thing that happened* and the *state transition it caused* are separate facts. Reviewers later want to grep for `"event_type":"PROpened"` to count PRs without also matching the merged-PR transition.

`create-worktree.sh`'s idempotent re-run path **does not** emit an event when the worktree is already in place — the script no-ops, so the log no-ops. Same rule for `open-pr.sh` when `pr_url` is already set.

## The bash helper

Each script gets the same shape appended to its existing Python block:

```bash
PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${RUN_DIR}" <<'PY' || echo "warn: event-log append failed for ${RUN_DIR}" >&2
import sys
from pathlib import Path
from lib.events import Event, append
run_dir = Path(sys.argv[1])
append(run_dir, Event(
    event_type="TransitionApplied",
    actor="script:create-worktree.sh",
    from_state="<captured-earlier>",
    to_state="in_progress",
    payload={"worktree_path": "<...>", "branch_name": "<...>"},
))
PY
```

The `|| echo "warn: ..."` clause is the "best-effort" promise. Status has already been saved by the previous Python block; this is only the audit trail.

For scripts that need two events (qa-pass, open-pr), it's one Python block with two `append()` calls.

To keep the Python blocks readable, the `from_state` and payload values get captured into bash vars *before* the Python block runs, then interpolated. The existing scripts already do this for `STATUS`, `BRANCH_NAME`, etc., so the pattern is consistent.

## The validate-workbench.sh check

Add one block to the per-run loop in `validate-workbench.sh` (right after the existing Beads-sync check):

```bash
# Event-log consistency: if events.jsonl exists, its latest TransitionApplied
# to_state must equal metadata.status.
if [[ -f "${run_dir}/events.jsonl" ]]; then
  EVENT_PROBE="$(
    PYTHONPATH="${WORKBENCH_ROOT}" python3 - "${run_dir}" "${RUN_STATUS}" <<'PY' 2>&1 || true
import sys
from pathlib import Path
from lib.events import last_transition
run_dir = Path(sys.argv[1])
expected = sys.argv[2]
ev = last_transition(run_dir)
if ev is None:
    print("NO_TRANSITION")
elif ev.to_state != expected:
    print(f"DRIFT:{ev.to_state}|{expected}")
else:
    print("OK")
PY
  )"
  case "${EVENT_PROBE}" in
    OK) ;;  # silent on success
    NO_TRANSITION)
      # Allowed only for runs that have never transitioned (status=draft).
      [[ "${RUN_STATUS}" == "draft" ]] || warn "${run_dir}: events.jsonl has no TransitionApplied but status=${RUN_STATUS}"
      ;;
    DRIFT:*)
      drift="${EVENT_PROBE#DRIFT:}"
      fail "${run_dir}: event-log drift — events say to_state=${drift%%|*}, metadata says status=${drift##*|}"
      ;;
    *)
      warn "${run_dir}: events.jsonl probe failed: ${EVENT_PROBE}"
      ;;
  esac
fi
```

Drift is a `fail` (hard error) because the whole point of the event log is to be the canonical history; if it disagrees with `metadata.yaml`, something is wrong and we want to know. Existing runs created before Move 3 won't have `events.jsonl` — the `[[ -f ]]` guard skips them silently.

## Tests

### Unit

`tests/test_events.py` already covers `last_transition`. No new lib tests needed for the validator logic itself — it's a small bash glue layer over functions that are already tested.

### End-to-end (manual)

Same shape as the 05/11 `/draft-pr` test:

1. Spin up `/tmp/move3-test/product-repo` as a throwaway git repo.
2. Point a temp `config/repos.yaml` at it.
3. `./scripts/new-feature.sh frontend smoke "test event log wiring"`.
4. **Expect:** `runs/<run_id>/events.jsonl` exists with one `TaskCreated` line, `to_state=draft`.
5. Manually flip metadata to `planned` (or accept whatever `new-feature.sh` left as default). Then:
6. `./scripts/create-worktree.sh runs/<run_id>` → expect a `TransitionApplied` event with `to_state=in_progress`.
7. Make a commit in the worktree.
8. `./scripts/qa-pass.sh runs/<run_id> -r pass -t timothy -s "smoke"` → expect a `QAVerdict` event + a `TransitionApplied` event with `to_state=qa`.
9. `./scripts/complete-run.sh runs/<run_id> --remove-worktree --delete-branch --force` → expect a `TransitionApplied` event with `to_state=merged`.
10. `./scripts/validate-workbench.sh` → expect clean (no event-log warnings or errors).
11. Tamper test: manually edit `metadata.yaml` to set `status: in_progress`. Re-run `validate-workbench.sh` → expect a `fail` line for that run with the drift message.
12. Restore. Cleanup.

That's the same harness style I used 05/11 and it caught real bugs.

## Order of implementation

1. **`new-feature.sh`** — simplest: one new event, no `from_state` to capture. Validates the pattern.
2. **`create-worktree.sh`** — adds the `from_state` capture. Skip-on-idempotent path matters here.
3. **`qa-pass.sh`** — first script with two events. Tests the two-event flow.
4. **`complete-run.sh`** — handles both `merged` and `abandoned` branches.
5. **`open-pr.sh`** — last because of the idempotency branch (re-run with `pr_url` set must NOT emit).
6. **`validate-workbench.sh` consistency check.**
7. **End-to-end harness run** (manual, against a tempdir product repo).

## What this leaves alone (and why)

- `lib.metadata.save()` does not auto-emit. Coupling save() to disk-writing events would break every existing test that calls save() in a tempdir without an `events.jsonl`. Explicit emit calls keep tests deterministic.
- The 3 slash commands keep working unchanged — they invoke the scripts above, which now emit events.
- `transition_with_evidence()` stays in `lib/transitions.py`, unused by scripts for now. Move 4 (front-half slash commands) is where it earns its keep.
- No template change. `events.jsonl` is created on first append; nothing copies a "template" event log into a fresh run.

---

**05/14 — Stale-doc audit: LOG.md and README.md vs. disk + lib**

Cross-referenced LOG.md and README.md against `scripts/`, `lib/`, `.claude/commands/`, and `lib/metadata.py:VALID_STATUSES`. Findings:

LOG.md:
- The "TODO — `/draft-pr` polish" block from the 05/11 entry was a free-floating todo list embedded mid-log. Removed; if these become real work they should be filed as a plan entry, not left as inline TODOs that drift out of sync with the code.
- No standalone "end-to-end verified" entry for `/ingest-linear`, `/review-run`, `spawn-children.sh`, `sync-to-beads.sh`, `lib/wbs.py`, `lib/beads.py`, `lib/run.py`. They exist on disk and are covered by the 05/11 plan but never got an explicit smoke-test entry. Not removed — absence-of-evidence is itself useful signal — but called out here so future readers don't assume LOG is exhaustive.

README.md (fixed in the same session):
- Main lifecycle diagram only showed the original 6 states (`draft → planned → in_progress → in_review → qa → merged | abandoned`). `lib/metadata.py:VALID_STATUSES` now lists 12, including `normalize`, `brainstorm`, `ready`, `investigating`, `investigated`. Updated the diagram to show the full state set, with `planned` kept as the legacy alias for `ready` per the comment in `lib/metadata.py:21`.
- The `runs/<run_id>/` artifact listing was missing `events.jsonl`. Added.
- No mention anywhere of the per-run event log or evidence-bearing transitions (`lib/events.py`, `lib/transitions.py`), both of which have been wired into 5 lifecycle scripts (commit `726e669`) and a `validate-workbench.sh` consistency check. Added a short "Event log + evidence-bearing transitions" subsection right after "Centralized AI memory — philosophy" — same level of detail as the existing `gh` section.
- `docs/lifecycle.md` is also stale (same lifecycle drift). Not touched in this pass — README is the user-facing entry point and the higher-value fix. Filed mentally as a follow-up; will not leave a TODO in LOG.

What's still NOT verified end-to-end as of this audit:
- Real `gh pr create` against a real GitHub remote (carried over from 05/05).
- `/ingest-linear` against a real Linear ticket.
- `/review-run` happy path + bad-state rejection.
- `spawn-children.sh` reading a real WBS block.
- `sync-to-beads.sh` against a real `bd` install.

Each of those is a tempdir-harness test of the same shape as 05/11 (`/draft-pr`) and 05/13 (events wiring). They're worth doing before claiming the "Investigation → fan-out → review → PR" workflow in the README is acceptance-criteria complete.

---

**05/14 — Gap analysis: ideal state vs. current implementation**

The ideal flow is:

```
type a task (with a skill)
  → CLI fires to create the task
  → task is normalized into a set format
  → sent in for implementation
  → reviewed and validated
  → pushed as a draft PR
```

**NOTE:** the ideal implementation is multi-agent — each lifecycle stage spins up a new agent (one for normalize, one for brainstorm, one for implementation, one for review, etc.) rather than threading the work through a single long-lived session.

**NOTE:** the ideal implementation includes a dashboard that shows the current status of each task — at-a-glance "which runs are in which state right now."

Mapped against what's actually built today, by lifecycle stage:

## Stage 1 — "Type a task (with a skill)"

**Status:** PARTIAL. Only one slash-command entry point exists: `/ingest-linear <repo_key> <slug> <linear_url_or_KEY>`. It pulls a Linear ticket body via MCP into `raw-idea.md`. There is no `/new-task "<free-form description>"` slash command. To start from a raw idea today you run a shell command:

```bash
./scripts/new-feature.sh frontend better-onboarding "make onboarding less annoying"
```

**Why it's manual:** The Move 4 work (front-half slash commands) was deferred from the 05/13 plan. No `/new-task`, `/normalize`, or `/brainstorm` slash command exists under `.claude/commands/`. The user has to open a terminal and invoke `new-feature.sh` directly.

## Stage 2 — "CLI fires to create the task"

**Status:** YES. `scripts/new-feature.sh` is fully automated end-to-end: generates `run_id`, creates `runs/<run_id>/` populated from 8 templates, renders `metadata.yaml` with `status=draft`, appends `TaskCreated` to `events.jsonl`, optionally mirrors to Beads. This stage is *not* the gap.

**Why it's manual (only) for invocation:** see Stage 1 — the *script* runs, but nothing fires it from a slash command except `/ingest-linear`.

## Stage 3 — "Normalize into a set format"

**Status:** NO. This is the largest gap by far. After `new-feature.sh` runs, `raw-idea.md` contains the user's verbatim free-form text and `normalized-feature-input.md` + `spec.md` are blank templates. There is no automation that reads `raw-idea.md` and produces a structured spec.

**Why it's manual:**
- No `/normalize` slash command exists. The README says (line 96-98): *"(edit raw-idea.md → normalized-feature-input.md → spec.md by hand or with an agent)"* and *"(manually flip status to 'planned' in metadata.yaml when spec is approved)"*. Those are explicit human-in-the-loop steps documented as such.
- No `/brainstorm` slash command exists. The `decisions.md` template has a WBS block but populating it (with the 2-4 implementation approaches that the lifecycle promises) is also a human-with-an-agent task today.
- The new statuses `normalize`, `brainstorm`, `ready` were added to `lib/metadata.py:VALID_STATUSES` in commit `4162164` and have evidence rules declared in `lib/transitions.py:EVIDENCE` (e.g. `brainstorm → ready` requires `approved_by`). But nothing emits those transitions yet — they are infrastructure waiting for a caller.
- Result: today the user goes `draft → in_progress` directly via `create-worktree.sh`, skipping `normalize`, `brainstorm`, and `ready` entirely. The state machine *allows* the skip because `create-worktree.sh`'s metadata-update block still treats `draft` and `planned` as equivalent entry points.

**Multi-agent expectation, not met:** even the eventual `/normalize` and `/brainstorm` commands as scoped in the deferred Move 4 plan would run in the *same* Claude Code session that the user typed `/new-task` in, not as separately-spawned agents. No worker process spins up per stage; no agent boundaries are enforced; no per-stage permissions or retry budgets exist.

## Stage 4 — "Sent in for implementation"

**Status:** PARTIAL. The plumbing fires automatically — `scripts/create-worktree.sh` validates the product repo, creates a worktree at `worktrees/<run_id>/` on branch `ai/<run_id>`, transitions `* → in_progress`, and appends a `TransitionApplied` event. After that point, **the human opens a new Claude Code session in the worktree and codes there.**

**Why it's manual:**
- There is no implementation agent. The README explicitly says the workbench is the substrate for agent work, not the agent (`docs/architecture.md:96`).
- No script or slash command starts a coding session, invokes Claude headlessly (e.g. `claude -p`), or wires a coding agent into the worktree. The user does this themselves in a fresh interactive session.
- No retry budget, no test/fix loop, no failure diagnoser. The 05/06 entry's gap list called out items 5 ("bounded retry helpers") and 7 ("agent driver under `lib/agent/`") as the largest unbuilt pieces — they remain unbuilt.

**Multi-agent expectation, not met:** the worktree is created automatically but nothing spawns a coding agent into it. The handoff from orchestration to coding is "human opens a new terminal."

## Stage 5 — "Reviewed and validated"

**Status:** YES. Two slash commands cover this stage:

- `/review-run <run_dir> [--agent <name>]` — invokes a review skill (default `dg`) against the worktree, captures the verdict, pipes it into `scripts/qa-pass.sh -n -`, which appends a `QA-N` entry to `qa-log.md`, transitions `* → qa`, and emits `QAVerdict` + `TransitionApplied` events.
- `/draft-pr <run_dir>` — captures `git diff --stat` into `run-log.md` and stitches `pr-summary.md` from `spec.md` + `decisions.md` + `qa-log.md` + `run-log.md`.

**Why it is NOT fully manual:** these two slash commands are the working examples of "skill-bearing slash command that runs deterministic plumbing inline." They are how the front half should eventually look.

**Multi-agent expectation, partly met:** `/review-run` does invoke a separate skill (e.g. `dg`, `simplify`, `pr-review`) via the `Skill` tool, which is closer to "separate agent for review" than anywhere else in the system. But it still runs *inside* the calling session, not as a spawned subprocess or subagent, and the agent has access to the calling session's full tool surface.

## Stage 6 — "Pushed as a draft PR"

**Status:** YES. `scripts/open-pr.sh <run_dir>` runs `gh auth status`, validates worktree-is-on-expected-branch, confirms commits ahead of default, `git push -u origin <branch>`, `gh pr create --draft --body-file pr-summary.md`, parses the PR URL and number, writes them back to `metadata.yaml`, prepends a PR banner to `pr-summary.md`, transitions `* → in_review`, and emits `PROpened` + `TransitionApplied` events. Idempotent: re-running with `pr_url` already set is a no-op.

**Why it's manual (only) for invocation:** nothing fires `open-pr.sh` automatically when review completes. The user invokes it themselves after seeing a green review verdict.

`scripts/check-pr.sh` polls `gh pr view --json` for CI/check status and appends a summary to `run-log.md` — but it deliberately does not change status. The CI-fix loop is human-driven.

## Dashboard

**Status:** NO. Does not exist in any form.

**Why it's manual:**
- The only way to see "what's the state of each task" today is to grep `runs/*/metadata.yaml` for `status:` lines, or run `validate-workbench.sh`, which prints one `ok run-id [type/status] bead=...` line per run as part of its `[runs]` block. That's a list, not a dashboard.
- Beads (`bd`) provides a queryable index when installed (`bd ready`, `bd query`, etc.) — but it's a CLI tool, optional, and one-way-synced from `metadata.yaml`. Even when present, it's a per-issue list view, not a live status board.
- No HTML/TUI/web dashboard exists. No `dashboard.html`, no `wb dashboard`, no Streamlit/Flask/Gradio app, no read-only view that surfaces "5 runs in_progress, 2 in_review, 1 stuck in qa for 3 days." The data is all in `metadata.yaml` + `events.jsonl` (so a dashboard *could* be built on top), but the dashboard layer itself is unbuilt.

## Cross-cutting: state machine plumbing

What *is* built, that the eventual multi-agent flow will consume:

- **`lib/transitions.py:EVIDENCE`** — declares required evidence keys for every documented edge in the lifecycle (e.g. `qa → merged` requires `tests_passed`, `pr_url`, `merge_sha`). Unused by any current caller.
- **`lib/events.py`** — append-only JSONL log per run. Wired into 5 lifecycle scripts. Available to any future stage agent.
- **`validate-workbench.sh` consistency check** — hard-fails if `metadata.yaml.status` diverges from the most recent `TransitionApplied.to_state`. Currently the only enforcement mechanism that catches drift.

These three pieces are the back-end contract that future stage agents would write through. None of them is wired to a UI, a queue, a worker pool, or a separate-process agent runtime.

## Summary table

| Stage                          | Automated? | What's missing                                                                 |
|--------------------------------|------------|--------------------------------------------------------------------------------|
| 1. Type a task (with skill)    | PARTIAL    | No `/new-task` slash command for free-form input; only `/ingest-linear`        |
| 2. CLI creates the task        | YES        | (script runs; only invocation is manual — covered by Stage 1)                  |
| 3. Normalize to set format     | NO         | No `/normalize`, no `/brainstorm`; user hand-edits two templates + flips status |
| 4. Sent for implementation     | PARTIAL    | Worktree created automatically; coding is a fresh human-opened session         |
| 5. Reviewed and validated      | YES        | (handled by `/review-run` + `/draft-pr`)                                       |
| 6. Pushed as draft PR          | YES        | (handled by `open-pr.sh`; invocation is manual)                                |
| **Multi-agent per stage**      | NO         | All slash commands run inside one calling session; no per-stage workers        |
| **Status dashboard**           | NO         | No dashboard exists in any form — only `validate-workbench.sh` text output     |
