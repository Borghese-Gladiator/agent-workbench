# ai-workbench

A standalone, single-user **control plane** for AI-assisted software development across
multiple local product repositories.

`ai-workbench` is the place where ideas become specs, specs become tasks, tasks become
worktrees, and worktrees become PRs. Product repos stay clean — they only ever receive
real source-code changes. Everything else (raw ideas, normalized inputs, specs,
implementation logs, decisions, QA notes, PR summaries) lives here.

---

## Why this exists

Working with AI agents across many repos creates two problems:

1. **Scattered memory.** Specs end up in one repo, decisions in another, QA notes
   in a Notion doc, and PR summaries vanish into git history.
2. **Polluted product repos.** Planning folders (`/specs`, `/runs`, `/ai`, `/beads`,
   `/logs`) leak into source trees, mixing orchestration with shipped code.

`ai-workbench` solves both: a single, centralized, version-controlled memory store
plus a worktree-based execution model that keeps product repos pristine.

---

## Control-plane architecture

```
ai-workbench/                 ← orchestration (this repo)
├── ideas/                    ← raw + normalized idea staging
├── runs/<run_id>/            ← canonical artifact home for one feature
├── worktrees/<run_id>/       ← isolated checkout of a product repo
├── templates/                ← seeds copied into every new run
├── scripts/                  ← lifecycle automation
├── lib/                      ← Python helpers
├── config/repos.yaml         ← product-repo registry (absolute paths)
└── docs/                     ← architecture, lifecycle, beads notes

product-repo-A/   ← clean source code; only feature branches land here
product-repo-B/   ← clean source code; only feature branches land here
```

A single product repo may be the target of many runs over time. The product repo never
learns about ai-workbench — it just sees normal feature branches like `ai/<run_id>`
appear, get pushed, and merge.

A "product repo" in this sense is a **project**: it might be a standalone git repo
(the common case) or a **subdirectory inside a larger git repo** (e.g. one project
in a playground monorepo). See [Subdirectory projects](#subdirectory-projects)
below.

---

## The run

A **run** is one feature implementation effort. It owns a directory:

```
runs/<run_id>/
  metadata.yaml             ← canonical state (the only source of truth)
  events.jsonl              ← append-only audit trail of state transitions
  raw-idea.md
  normalized-feature-input.md
  spec.md
  run-log.md
  decisions.md
  qa-log.md
  pr-summary.md
```

`run_id` format:

```
YYYY-MM-DD-<feature-slug>-NNN
e.g.  2026-05-06-better-onboarding-001
```

Collisions on the same day auto-increment the numeric suffix; existing runs are never
overwritten.

> **Important:** `metadata.yaml` is the canonical source of truth. Do **not** parse
> important state (repo, branch, status) out of directory names.

---

## Lifecycle

```
draft → normalize → brainstorm → ready → in_progress → in_review → qa → merged
                                          └──→ abandoned

   (investigation runs only)
draft → planned → investigating → investigated → merged
```

`planned` is kept as a legacy alias for `ready` until callers migrate; both are
valid simultaneously (see `lib/metadata.py`). `investigating` and `investigated`
are gated to `run_type == "investigation"`. Any non-terminal state can transition
to `abandoned` via `complete-run.sh --abandon`.

See [`docs/lifecycle.md`](docs/lifecycle.md) for the state machine.

Typical flow:

```
./scripts/new-feature.sh frontend better-onboarding "make onboarding less annoying"
# → creates runs/2026-05-06-better-onboarding-001/  (status: draft)

# (edit raw-idea.md → normalized-feature-input.md → spec.md by hand or with an agent)
# (manually flip status through normalize → brainstorm → ready in metadata.yaml as
#  the spec firms up; "planned" is still accepted as a legacy alias for "ready")

./scripts/create-worktree.sh runs/2026-05-06-better-onboarding-001
# → creates worktree at worktrees/2026-05-06-better-onboarding-001/
# → creates branch ai/2026-05-06-better-onboarding-001 in the product repo
# → status: in_progress

# (implement in the worktree, append to run-log.md and decisions.md as you go)

/draft-pr runs/2026-05-06-better-onboarding-001
# → stitches pr-summary.md from spec/decisions/qa-log/run-log; captures diff
#   stat into run-log.md (slash command, runs inside the active session)

./scripts/open-pr.sh runs/2026-05-06-better-onboarding-001     # optional, requires gh
# → pushes the branch and opens a draft PR; status: in_review

./scripts/check-pr.sh runs/2026-05-06-better-onboarding-001    # optional, requires gh
# → appends CI / check / review summary to run-log.md (loop until green)

./scripts/qa-pass.sh runs/2026-05-06-better-onboarding-001
# → appends a QA pass entry; status: qa

./scripts/complete-run.sh runs/2026-05-06-better-onboarding-001
# → status: merged; optionally removes worktree + deletes branch; preserves artifacts
```

---

## Worktree strategy

Each run gets its own git worktree, checked out from the configured product repo.

- **Branch:** `ai/<run_id>` (created from the product repo's default branch).
- **Path:** `worktrees/<run_id>/` inside ai-workbench.
- **Isolation:** runs never share a worktree. Concurrent runs on the same product
  repo are fine — git worktrees are designed for it.
- **Cleanup:** `complete-run.sh` can remove the worktree and delete the branch
  (after merge) without touching the run's artifacts.

---

## Subdirectory projects

A **project** registered in `config/repos.yaml` does not have to be a top-level
git repo. The workbench supports two shapes via one optional field:

| Shape | `path` | `project_subpath` | `project_dir` |
|---|---|---|---|
| **Standalone repo** (common) | absolute path to git root | unset / `""` | == `path` |
| **Subdirectory project** | absolute path to git root | relative path inside | `path/<project_subpath>` |

The git plumbing always operates on the **git root** (`path`):
- `git worktree add` cuts from there.
- Feature branches `ai/<run_id>` live there.
- `gh pr create` opens PRs against the GitHub repo identified by `github`.

The **agent's working directory** is `worktrees/<run_id>/<project_subpath>/`.
That's where files get edited, where dev servers run, and where conventions
like "no `/runs` or `/specs` folders" are enforced.

Implications for subdirectory projects:

- **Branch noise.** Every `ai/<run_id>` branch exists in the parent monorepo,
  even when only one subdir's files change. That's fine for personal /
  playground monorepos; reconsider if the parent repo has stricter branch
  policies.
- **PR scope.** A PR opened by `open-pr.sh` always targets the parent repo
  on GitHub. The diff may only touch the subdirectory, but the PR is filed
  against `github` from the parent repo's config — that's just how git works.
- **`validate-product-repos-clean.sh`** only scans the **project dir**, not
  the whole git root. Other subdirectories of the same monorepo are out of
  scope.
- **Worktrees stay full.** `git worktree add` does not support partial-tree
  checkouts; the worktree contains the entire monorepo. The agent simply
  works inside the right subdirectory.

Example entry in `config/repos.yaml`:

```yaml
repos:
  cards-president-first:
    path: /Users/me/code/playground-monorepo
    project_subpath: cards-president-first
    github: me/playground-monorepo
    default_branch: master
```

---

## Artifact locations

| Artifact | Lives in |
|---|---|
| Raw idea | `runs/<run_id>/raw-idea.md` |
| Normalized feature input | `runs/<run_id>/normalized-feature-input.md` |
| Spec / BRD | `runs/<run_id>/spec.md` |
| Implementation log | `runs/<run_id>/run-log.md` |
| Decisions (ADR-style) | `runs/<run_id>/decisions.md` |
| QA log | `runs/<run_id>/qa-log.md` |
| PR summary | `runs/<run_id>/pr-summary.md` |
| Run state | `runs/<run_id>/metadata.yaml` |
| Event log | `runs/<run_id>/events.jsonl` |
| Source-code changes | the product repo, on branch `ai/<run_id>` |

---

## Branching model

- Feature branch: `ai/<run_id>` in the product repo.
- Branched from: the product repo's configured `default_branch`.
- Merged via the product repo's normal PR flow. ai-workbench is not in the merge path.
- After merge, `complete-run.sh` may delete the local feature branch; the merged
  history lives in the product repo as usual.

---

## Centralized AI memory — philosophy

Every artifact in `runs/` is durable, structured, version-controlled context that any
agent (or human) can rehydrate from later. We deliberately:

- **Never** scatter planning artifacts across product repos.
- **Never** rely on chat history or ephemeral agent state.
- **Always** treat `metadata.yaml` as canonical.
- **Always** append, never overwrite, in `run-log.md` / `decisions.md` / `qa-log.md`.

The repo grows into a queryable corpus of "what we built, why, and what broke."

---

## Event log + evidence-bearing transitions

`metadata.yaml` stays canonical. Alongside it, every run has an append-only
`events.jsonl` written by the lifecycle scripts whenever they flip status. The
event log is the historical record of how a run got to its current state — useful
for replay, auditing, and queries like "which runs failed review twice this month."

```jsonl
{"created_at": "2026-05-13T20:11:43Z", "event_type": "TaskCreated", "actor": "script:new-feature.sh", "from_state": "", "to_state": "draft", "payload": {...}}
{"created_at": "2026-05-13T20:14:02Z", "event_type": "TransitionApplied", "actor": "script:create-worktree.sh", "from_state": "draft", "to_state": "in_progress", "payload": {...}}
```

Five scripts emit events today: `new-feature.sh`, `create-worktree.sh`,
`qa-pass.sh`, `open-pr.sh`, `complete-run.sh`. Idempotent re-runs (e.g.
re-running `create-worktree.sh` when the worktree already exists, or `open-pr.sh`
with `pr_url` already set) correctly emit no duplicate events.

`validate-workbench.sh` enforces consistency: if `events.jsonl` exists, its most
recent `TransitionApplied.to_state` must equal `metadata.status`. Drift is a hard
failure — the whole point of the event log is to be a faithful audit trail.

Event-log writes are **best-effort**: a failure prints a warning but never blocks
the script. `metadata.yaml` is canonical; the event log is the audit trail, not a
gate. See [`lib/events.py`](lib/events.py).

Separately, [`lib/transitions.py`](lib/transitions.py) declares the required
evidence for every documented edge (e.g. `qa → merged` requires `tests_passed`,
`pr_url`, `merge_sha`). All five lifecycle scripts now call
`transition_with_evidence`; missing or empty evidence is a hard rejection.
See [`docs/lifecycle.md`](docs/lifecycle.md) for the full edge-by-edge
evidence table.

---

## Status dashboard (`wb-watch`)

A read-only watch-mode TUI for the runs corpus:

```bash
./scripts/wb-watch.py            # 2s refresh
./scripts/wb-watch.py --interval 5
```

What it shows:

- All runs in `runs/`, sorted, with `status`, `run_type`, age since last
  event, and the most recent event in compressed form.
- A drill-down panel for the highlighted run: `feature_slug`, repo,
  branch, worktree, PR (if any), and the evidence keys that the run's
  **next canonical transition** will require — useful for "what do I
  need to provide to advance this?".
- The last five events for the selected run, freshest first.

Keybindings: `↑`/`k` and `↓`/`j` to select; `r` to force a refresh; `q`
or `Esc` to quit. Stdlib-only (curses, no `rich`).

---

## Agent Operating Rules

Any agent working inside this system MUST follow these rules:

- **All planning artifacts remain inside ai-workbench.** Specs, logs, decisions, QA
  notes, and PR summaries live under `runs/<run_id>/`. They never appear in product
  repos.
- **Product repos contain source code only.** No `/specs`, `/runs`, `/ai`, `/beads`,
  `/logs`, or other orchestration directories may be created inside a product repo.
  Run `scripts/validate-product-repos-clean.sh` to verify.
- **Every implementation session updates `run-log.md`.** Append a timestamped entry
  describing what was attempted, what worked, what failed, and what is next.
- **Every major decision updates `decisions.md`.** Record the choice, the alternatives
  considered, and the reasoning, ADR-style.
- **Every QA pass updates `qa-log.md`.** Record the date, what was tested, findings,
  and the resulting status.
- **PR summaries derive from run artifacts.** `pr-summary.md` is generated from the
  spec, run log, decisions, and QA log — not written in isolation.
- **Agents must never create orchestration folders inside product repos.** When in
  doubt, write the artifact into the run directory in ai-workbench.
- **`metadata.yaml` is the only source of truth for run state.** Do not infer
  repo/branch/status from directory names.

---

## Quick start

```bash
./scripts/init-repo.sh
cp config/repos.yaml.example config/repos.yaml
# edit config/repos.yaml to point at your real product repos (absolute paths)
./scripts/validate-workbench.sh
```

See [`docs/architecture.md`](docs/architecture.md) for the design rationale and
[`docs/beads-integration.md`](docs/beads-integration.md) for the future Beads story.

---

## GitHub CLI integration (optional)

ai-workbench can drive draft-PR creation and CI/check follow-up via the
[GitHub CLI (`gh`)](https://cli.github.com/). The integration is **optional**:
the entire run lifecycle works without `gh`, and `validate-workbench.sh` only
warns when `gh` is missing (it fails only for runs that explicitly opt in via
`github_cli_required: "true"` in their `metadata.yaml`).

### Prerequisites

```bash
# install gh (macOS):
brew install gh

# authenticate once per machine:
gh auth login
```

`validate-workbench.sh` reports both whether `gh` is on `PATH` and whether
`gh auth status` is happy.

### Open a draft PR

After implementing in the worktree and committing on the feature branch:

```bash
./scripts/open-pr.sh runs/<run_id>
```

What this does, in order:

1. Verifies `gh` is installed and authenticated.
2. Reads `metadata.yaml`; refuses to run if `worktree_path`, `branch_name`,
   `repo_path`, `github_repo`, or `default_branch` is missing.
3. **Idempotency:** if `metadata.yaml` already has `pr_url`, prints it and exits.
4. Confirms the worktree is on the expected feature branch.
5. Confirms the feature branch has commits ahead of `default_branch`.
6. Confirms the configured remote (`remote_name`, default `origin`) exists on
   the product repo.
7. `git push -u <remote> <branch>`.
8. `gh pr create --draft` against `<github_repo>` with body from `pr-summary.md`.
9. Parses `pr_url` and `pr_number` from `gh` output and writes them into
   `metadata.yaml`.
10. Prepends a `> **PR:** <url>` banner to `pr-summary.md`.
11. Transitions status `→ in_review`.

Override the remote with `--remote <name>` or skip the push step with
`--no-push` if the branch is already published.

### CI / review follow-up loop

```bash
./scripts/check-pr.sh runs/<run_id>
```

What this does:

1. Reads `pr_url` + `pr_number` from `metadata.yaml`.
2. Calls `gh pr view --json` for state, mergeable, draft flag, status checks,
   reviews, review decision, and unresolved comments.
3. Formats a summary (success/failure/pending check counts, names of failing
   checks, recent review comments).
4. Appends a timestamped entry to `runs/<run_id>/run-log.md`.
5. Prints the same summary to stdout for the agent or human to react to.

`check-pr.sh` deliberately does **not** change run status. The CI-fix loop
typically looks like:

```text
check-pr.sh        # CI red, log shows failing checks
# (fix in worktree, commit, push)
check-pr.sh        # checks now pending, then green
qa-pass.sh         # status → qa
complete-run.sh    # after the PR merges (status → merged)
```

### Per-run gh requirement flag

Set `github_cli_required: "true"` in a run's `metadata.yaml` if that run
genuinely cannot proceed without `gh`. `validate-workbench.sh` will then fail
(rather than warn) on machines without `gh` installed. Leave it `"false"`
(the default) for runs that don't need PR automation.

---

## Investigation → fan-out → review → PR workflow

A single Linear ticket can be ingested as a tree of runs:

```
runs/2026-05-06-core-577-investigation-001/      (run_type: investigation)
  ├── runs/2026-05-06-core-577-dashboard-shell-001/    (run_type: feature)
  ├── runs/2026-05-06-core-577-channel-data-api-001/   (run_type: feature)
  └── runs/2026-05-06-core-577-channel-widget-ui-001/  (run_type: feature)
```

with one command per phase. Three of the seven steps are **slash commands**
that run inside the active Claude Code session — they need MCP and the
Skill tool, which shell scripts can't invoke. The other four are shell
scripts (deterministic plumbing only).

```bash
# 1. Ingest a Linear ticket as an investigation run. (slash command)
/ingest-linear <repo_key> <slug> <linear_url_or_KEY-###>
#    → creates runs/<date>-<slug>-investigation-NNN/ with linear_ticket set
#    → fetches the ticket body via Linear MCP into raw-idea.md
#    → stitches normalized-feature-input.md
#    → run_type: investigation, status: draft

# 2. Author spec.md by hand or with an agent in the run dir.
#    Manually flip status: draft → planned → investigating in metadata.yaml.

# 3. Investigate inside the parent's worktree.
./scripts/create-worktree.sh runs/<investigation_run_id>
#    Run the investigation agent; append findings to run-log.md.
#    Populate the WBS block in decisions.md (see template).

# 4. Fan out the WBS into N child implementation runs.
./scripts/spawn-children.sh runs/<investigation_run_id>
#    → reads the WBS block from decisions.md
#    → creates one child run per WBS item, each with parent_run_id set
#    → inherits linear_ticket from the parent
#    → parent status: investigating → investigated

# 5. Implement each child in its own worktree (in parallel if you want).
./scripts/create-worktree.sh runs/<child_run_id>     # per child

# 6. Run an adversarial review per child worktree. (slash command)
/review-run runs/<child_run_id> --agent dg
#    → invokes the named review skill against the worktree
#    → records the verdict in qa-log.md and flips status → qa

# 7. Draft the PR description; open the PR. (slash command + script)
/draft-pr runs/<child_run_id>
#    → captures `git diff --stat` into run-log.md
#    → stitches pr-summary.md from spec/decisions/qa-log/run-log
./scripts/open-pr.sh runs/<child_run_id>             # creates draft PR
./scripts/check-pr.sh runs/<child_run_id>            # CI follow-up loop
```

### `metadata.yaml` fields used

| Field            | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `run_type`       | `investigation` \| `feature` \| `review` \| `hotfix`       |
| `parent_run_id`  | Set on children by `spawn-children.sh`                     |
| `linear_ticket`  | URL or `KEY-###` identifier; inherited by children         |
| `beads_task_id`  | Populated by `sync-to-beads.sh` (Beads is optional)        |

### Lifecycle additions for investigations

`investigating` and `investigated` are status values gated to
`run_type == "investigation"`. See [`docs/lifecycle.md`](docs/lifecycle.md).

### Slash commands for agent-bearing steps

Three steps in the workflow need an LLM in-session — Linear MCP for ticket
ingest, the Skill tool for adversarial review, and prose stitching for the
PR description. Shell scripts can't do any of those, so those three steps
are slash commands under [`.claude/commands/`](./.claude/commands):

1. **`/ingest-linear <repo_key> <slug> <linear_url_or_KEY>`** — scaffolds
   the investigation run, patches `metadata.yaml`, fetches the ticket body
   via Linear MCP into `raw-idea.md`, stitches
   `normalized-feature-input.md`, and mirrors the bead.
2. **`/review-run <run_dir> [--agent <name>]`** — validates the run is
   reviewable, invokes the named review skill (default `dg`) against the
   worktree, and records the verdict via `qa-pass.sh`.
3. **`/draft-pr <run_dir>`** — captures the diff stat into `run-log.md` and
   stitches `pr-summary.md` from `spec.md` + `decisions.md` + `qa-log.md` +
   `run-log.md` per the canonical template structure.

All three call into [`lib/run.py`](lib/run.py) for the shared
load-and-validate step. See [`docs/architecture.md`](docs/architecture.md)
for why these are slash commands instead of scripts.

### Beads integration (optional)

If [Beads](https://github.com/steveyegge/beads) (`bd`) is installed,
ai-workbench mirrors each run as a Beads issue. Beads becomes the
**queryable index** over runs without disturbing the canonical workbench
state.

```bash
./scripts/sync-to-beads.sh runs/<run_id>     # idempotent; called automatically
                                              # by the lifecycle scripts.
bd query …                                    # cross-run queries
bd children <bead_id>                         # list children of an investigation
bd search "linear.app/.../CORE-577"           # find runs from a Linear ticket
```

`metadata.yaml` is the source of truth; Beads is derived. The sync is
**one-way** (workbench → Beads). See
[`docs/beads-integration.md`](docs/beads-integration.md) for the mapping
table and limitations.

### Architecture boundary

- **One-way Beads sync.** `metadata.yaml` is canonical. We never mutate
  workbench state from Beads. If Beads disagrees, metadata wins; re-run
  `sync-to-beads.sh` to converge the index.
- **Shell scripts vs. slash commands.** Shell scripts handle deterministic
  plumbing (git, gh, filesystem, status flips). Slash commands handle
  LLM-bearing steps that need MCP or the Skill tool. There's no "agent
  handoff" wall mid-workflow — every step is either a script or a command,
  both invoked from the same Claude Code session. See
  [`docs/architecture.md`](docs/architecture.md).
