# Plan: make the addendum workflow actually run end-to-end

## Brief

The "Investigation → fan-out → review → PR" section at the bottom of `README.md` describes a workflow with three handoff points (lines 367–381) that today are walls:

1. **`from-linear.sh`** — needs Linear MCP. Today it prints "now open a Claude Code session and ask…"
2. **`review.sh`** — needs to invoke a slash-command skill (`/dg`) inside the worktree. Today it prints similar instructions.
3. **`draft-pr-summary.sh`** — needs an LLM to stitch `pr-summary.md` from artifacts. Today it captures `git diff --stat` and prints instructions.

Each one runs as a shell script outside any Claude Code session, where MCP tools and the Skill tool don't exist. So the script does the deterministic part, prints a paragraph, and asks the human to context-switch into a new session, paste the prompt, do the work, and come back. End-to-end, the workflow is three workflows held together by trust.

The fix is small: **make the handoff *be* a slash command instead of a script that prints instructions for a slash command.** A slash command runs *inside* the active session — MCP and Skill are available in-process. The deterministic plumbing each script does today moves into a Bash block at the top of the slash-command markdown. The prose-handoff at the bottom becomes the actual Claude turn that does the work.

This plan **deletes both prior plans** in `plan.md` (the original 15-script lifecycle and the bd-canonical `wb` rewrite). Neither was wrong, but neither solved the actual broken thing. The bd-canonical rewrite was a 500-line swing at a drift problem that hasn't bitten us; this plan is a 1-day patch at the workflow problem that bites every time.

`metadata.yaml` stays canonical. `bd` stays optional. The other 12 lifecycle scripts stay as-is — they're deterministic plumbing.

---

## Scope

**In:**
- Three new slash commands under `.claude/commands/` replacing the three handoff scripts.
- A small `lib/run.py` helper so the commands share path-resolution + metadata loading.
- A one-line addition to `scripts/qa-pass.sh` to accept notes from stdin (review verdicts can be multi-line).
- Deleting the three handoff scripts.
- Rewriting the README's addendum section + a one-paragraph note in `docs/architecture.md`.
- Tests for `lib/run.py`.

**Out:**
- The bd-canonical rewrite. `metadata.yaml` keeps being canonical for now. If drift between `metadata.yaml` and `bd` ever bites in practice, revisit then.
- Touching the other 12 scripts (`new-feature.sh`, `create-worktree.sh`, `open-pr.sh`, `check-pr.sh`, `qa-pass.sh` body, `pr-summary.sh`, `complete-run.sh`, `spawn-children.sh`, `sync-to-beads.sh`, `validate-*`).
- Auto-closing beads, polling GitHub for review comments, multi-round PR iteration.
- A `wb` CLI. The shell scripts that already work don't need a rewrite.

---

## The three slash commands

Each one is a markdown file under `.claude/commands/` with:

- A brief frontmatter / description block.
- A short Bash block at the top that runs the deterministic plumbing the existing script does (validation, run-dir resolution, file capture). This is the same code as today, in-place.
- A prose body that tells the model what to do next, using the run's loaded fields as variables.

### `.claude/commands/ingest-linear.md`

Replaces `scripts/from-linear.sh` plus the manual handoff.

**Invocation:** `/ingest-linear <repo_key> <feature-slug> <linear_url_or_KEY>`

**Steps the command performs:**

1. Validate args (`repo_key` against `config/repos.yaml`, kebab slug, Linear URL or `KEY-###`).
2. Run `scripts/new-feature.sh "<repo_key>" "<slug>-investigation" "see linear: <KEY>"` via Bash; capture `run_id` from stdout. Suppress the in-script `bd` mirror with `WORKBENCH_SKIP_BEADS_SYNC=1` so the bead gets the `investigation` run-type when we sync below.
3. Patch `runs/<run_id>/metadata.yaml`: set `linear_ticket=<KEY>` and `run_type=investigation`. Same `python3 -` block as `from-linear.sh` does today.
4. Use Linear MCP (`mcp__claude_ai_Linear__get_issue` or `mcp__linear-server__*`) to fetch the ticket body. Auth-prompt if not already authenticated.
5. Write the body verbatim into `runs/<run_id>/raw-idea.md` under `## Linear ticket body`.
6. Summarize the ticket into `runs/<run_id>/normalized-feature-input.md` following that template's heading structure.
7. Run `scripts/sync-to-beads.sh runs/<run_id>` so the bead has `run-type:investigation` from the start.
8. Print: `run_id`, run dir path, next step (`./scripts/create-worktree.sh runs/<run_id>` then author `spec.md`).

### `.claude/commands/review-run.md`

Replaces `scripts/review.sh` plus the "open a session in the worktree and run /dg" handoff.

**Invocation:** `/review-run <run_dir> [--agent <name>]`

`<name>` defaults to `dg`. Other reasonable values: `simplify`, `pr-review`.

**Steps:**

1. Resolve `<run_dir>` via `lib/run.py` (raises on missing dir or invalid metadata).
2. Refuse if `worktree_path` is empty or `status` isn't `in_progress` / `in_review`.
3. `cd "<worktree_path>"`. Confirm we're on `branch_name` via `git branch --show-current`.
4. Invoke the chosen review skill via the `Skill` tool (`Skill skill="dg"`).
5. Capture the verdict text (the skill's final message), categorize as pass/fail/inconclusive based on its content.
6. Pipe the verdict into `scripts/qa-pass.sh runs/<run_id> -r <result> -t <agent> -s "adversarial review" -n -` (the new stdin form — see "Supporting changes" below).
7. Print the verdict + the new run status.

If the named skill isn't available the `Skill` tool will surface an error. The command catches it and prints a clear message: "skill `<name>` not available — install or pick another with `--agent`."

### `.claude/commands/draft-pr.md`

Replaces `scripts/draft-pr-summary.sh` plus the "open a session and stitch pr-summary.md" handoff.

**Invocation:** `/draft-pr <run_dir>`

**Steps:**

1. Resolve `<run_dir>` via `lib/run.py`. Validate `worktree_path` exists and `default_branch` is set.
2. Capture `git -C <worktree> diff --stat <default_branch>...HEAD` and `git diff --name-only` and append a `## Files changed (auto)` section to `run-log.md`. (Same deterministic step `draft-pr-summary.sh` does today.)
3. Read `runs/<run_id>/{spec.md, decisions.md, qa-log.md, run-log.md}`.
4. Read `templates/pr-summary.md` to learn the canonical heading structure.
5. Write `runs/<run_id>/pr-summary.md` with content stitched from the artifacts, preserving the template's headings (Title / Why / What changed / How tested / Risk-rollout / Linked artifacts / Checklist).
6. Print which sections were filled from which artifact, then suggest opening the file to review before `./scripts/open-pr.sh runs/<run_id>`.

If the file already exists, overwrite with a one-line warning ("overwrote existing pr-summary.md"). No `--force` flag — the prior content is preserved in git history.

---

## Supporting changes

### `lib/run.py`

Stdlib-only. Exposes one dataclass and one function:

```python
@dataclass(frozen=True)
class RunInfo:
    metadata: Metadata
    run_dir: Path
    workbench_root: Path

class RunError(ValueError):
    pass

def load_run(run_dir_input: str) -> RunInfo:
    """Resolve <run_dir> (relative or absolute) and load metadata.yaml.

    Raises RunError on missing dir, missing metadata.yaml, invalid metadata,
    or run dir not under <workbench_root>/runs/.
    """
```

The three slash commands each invoke this from a `python3 -` block to avoid 15 lines of duplicated path resolution. Single source of truth for "what does it mean to load a run."

### `scripts/qa-pass.sh` — accept notes from stdin

Today: `qa-pass.sh ... -n "<text>"`. Multi-line review verdicts are awkward as a CLI argument and can hit shell-quoting bugs.

Add: `-n -` reads the notes from stdin until EOF and uses that. Backward-compatible.

### Deletions

- `scripts/from-linear.sh`
- `scripts/review.sh`
- `scripts/draft-pr-summary.sh`

### README rewrite

Two sections in `README.md`:

1. **"Investigation → fan-out → review → PR workflow"** (lines ~301–350): replace the current shell-script flow with one that uses the slash commands:

   ```
   /ingest-linear frontend core-577 CORE-577
   # (review the spec it produced; flip status manually as today)
   ./scripts/create-worktree.sh runs/<run_id>
   # (investigate; populate WBS in decisions.md)
   ./scripts/spawn-children.sh runs/<run_id>
   # (per child:)
   ./scripts/create-worktree.sh runs/<child_run_id>
   /review-run runs/<child_run_id>
   /draft-pr runs/<child_run_id>
   ./scripts/open-pr.sh runs/<child_run_id>
   ./scripts/check-pr.sh runs/<child_run_id>
   ```

2. **"Agent handoff points"** (lines ~367–381): replace with one paragraph noting the handoffs are slash commands that run in-session, with `lib/run.py` as the shared loader. Keep the architectural-boundary discussion at the bottom.

### `docs/architecture.md`

Add one short subsection — "Why slash commands instead of shell scripts for the handoffs":

> ai-workbench scripts run outside any Claude Code session. MCP tools and the Skill tool live inside a session. A handoff that needs MCP or another skill therefore can't be a shell script — it has to be a slash command. The deterministic plumbing (validation, file capture, status flips) still belongs in shell or `lib/`; only the LLM-bearing step lives in the slash command.

Don't touch the rest of the doc.

---

## Tests

### Unit (Python)

`tests/test_run.py`:
- `load_run` resolves a relative path under `runs/`.
- `load_run` resolves an absolute path.
- Raises `RunError` for missing dir.
- Raises `RunError` for missing `metadata.yaml`.
- Raises `RunError` for malformed metadata (delegates to `lib.metadata`).
- Round-trips through `lib.metadata.load`.

### Manual (slash-command end-to-end)

These can't be automated — they need Claude Code with Linear/Skill access. Run after implementation:

1. **`/ingest-linear` happy path** with a real Linear ticket. Verify run dir, `raw-idea.md` content, `normalized-feature-input.md` content, `metadata.yaml` fields, bead labels.
2. **`/ingest-linear` validation** — bad `repo_key`, bad slug shape, bad Linear key. Each fails loudly without leaving a half-created run.
3. **`/review-run` happy path** on a run with a worktree + commits. Verify `qa-log.md` entry, status transition, run-log entry.
4. **`/review-run` rejects bad state** — no worktree, wrong status. Same errors today's `review.sh` produces.
5. **`/draft-pr` happy path** on a run with all four artifacts populated. Verify headings match template, content drawn from artifacts, diff-stat block in `run-log.md`.
6. **`/draft-pr` re-run** — overwrites cleanly with a warning. `run-log.md` doesn't get duplicate diff-stat blocks (or, if it does, that's acceptable — they're both timestamped).

---

## Order of implementation

1. `lib/run.py` + `tests/test_run.py`. Smallest unit; foundation for the three commands.
2. Add `-n -` stdin support to `scripts/qa-pass.sh`. One-line shell change; needed by `/review-run`.
3. `.claude/commands/draft-pr.md`. Simplest of the three (no MCP, no Skill — just file stitching). Good first command to validate the pattern.
4. `.claude/commands/review-run.md`. Tests the `Skill`-tool integration.
5. `.claude/commands/ingest-linear.md`. Most complex — MCP + the existing `new-feature.sh` + metadata patch + `sync-to-beads.sh`.
6. Delete `from-linear.sh`, `review.sh`, `draft-pr-summary.sh`.
7. Rewrite README's addendum + one paragraph in `docs/architecture.md`.

Run unit tests after step 1. Run manual tests after step 6. Push after step 7.

---

## What this leaves alone (and why)

- **`metadata.yaml` stays canonical.** Drift between metadata and `bd` hasn't actually caused a bug; the bd-canonical rewrite was solving a hypothetical. The slash commands operate on the same canonical state today's scripts do.
- **The 12 other lifecycle scripts stay.** They're deterministic plumbing — exactly what shell is good at. Don't rewrite working code.
- **Beads stays optional and one-way.** `sync-to-beads.sh` keeps mirroring; `/ingest-linear` calls it as-is.
- **No `wb` CLI.** A new CLI would be a third source-of-truth for invocation conventions on top of the existing scripts and the new slash commands. Not worth it for a single-user local control plane.
