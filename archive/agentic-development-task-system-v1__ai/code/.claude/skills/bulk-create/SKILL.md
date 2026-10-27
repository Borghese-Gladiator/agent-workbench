---
name: bulk-create
description: Bulk-create an epic and a batch of tasks on the Agent Task System taskboard in one CLI call. Use when the user asks for a multi-task breakdown, a phased scaffold, or >3 tasks at once.
---

Bulk-create an epic and/or multiple tasks in a single command.

## When to use
- User asks to create more than ~3 tasks at once.
- User asks for a phased / multi-step breakdown of an initiative ("Phase A / B / C").
- User provides a bulleted list of tasks and says "add these."

## Steps

1. Gather (from the conversation or by asking):
   - Whether to create a **new epic** or attach to an **existing** one (grab its uuid).
   - The task list: `title` + `tags` + `acceptance_criteria` for each row.

2. Assemble the JSON payload (see schema below). Put shared fields — `epic_id`, actor, source, common tags — in `defaults`.

3. **Show the assembled JSON to the user** in a fenced code block and ask for confirmation. Do NOT run the CLI before confirmation.

4. After confirmation, run from the project root:
   ```bash
   npx tsx src/cli/ingest.main.ts batch '<json-payload>'
   ```
   For large payloads or tricky escaping, pipe via stdin instead:
   ```bash
   cat <<'JSON' | npx tsx src/cli/ingest.main.ts batch -
   { ... }
   JSON
   ```

5. Report the returned epic id (if any) and task count from the CLI's JSON output.

## Payload schema

Top level (tasks required, non-empty):
```json
{
  "defaults":  { "tags": ["setup"], "lane": "backend", "actor_id": "claude-code", "source": "claude-skill" },
  "epic":      { "title": "Poker game scaffold", "description": "Multi-phase breakdown.", "sort_order": 0 },
  "epic_id":   "<uuid>",
  "lane":      "backend",
  "sort_start": 0,
  "sort_step":  10,
  "tasks":     [ { "title": "...", "acceptance_criteria": "..." } ]
}
```

Task row (only `title` is required):
- `title`, `body`, `kind` (`task` | `bug`), `status`
- `epic_id`, `parent_id`
- `tags` (array of strings)
- `acceptance_criteria` (multi-line OK — use `\n`)
- `branch_name`, `assigned_agent_id`
- `lane` — free-form string (≤40 chars). Recommended vocabulary: `frontend`, `backend`, `infra`, `db`, `docs`, `test`. Cards in the same lane render with the same left-border color.
- `sort_order` — integer; overrides the auto-computed order for this row.
- `depends_on` — either a batch index (integer, 0-based, must be an *earlier* row) or a UUID of an existing work item. The task renders as "waiting" until its predecessor is `done`.
- `actor_id`, `actor_type`, `source`
- Any key starting with `_` is permitted as a human-readable annotation (e.g. `"_phase": "A — skeleton"`) and is discarded during ingest.

**Ordering.** Task array order is the board order. If no `sort_order` is set, rows get `sort_start + index * sort_step` (default `0, 10, 20, …`). Follow-on batches under the same epic should bump `sort_start` (e.g. `100`, `200`) to avoid collisions with earlier batches.

**Parallel vs serial.** Two rows that *both* `depends_on: 0` run in parallel once row 0 finishes. A chain `a ← b ← c` is expressed as `tasks[1].depends_on = 0`, `tasks[2].depends_on = 1`.

**Precedence for task `epic_id`** (lowest → highest):
`defaults.epic_id` < top-level `epic_id` < `epic:`-generated UUID < row-level `epic_id`

So when you include an `epic:` block, its generated UUID automatically becomes every task's `epic_id` — you don't need to repeat it.

**Precedence for `lane`** (lowest → highest):
top-level `lane` < `defaults.lane` < row-level `lane`.

## Batch identity

Every `bulk-create` call generates one `batch_id` that's stamped on the epic and every task. The CLI returns it in `summary` / top-level output. The board can be filtered by batch to see exactly what a single call produced — useful when reviewing a planner's output.

## Defaults
- `kind`: `task` (only use `bug` when the user explicitly says bug)
- `status`: `triage` (CLI default)
- `actor_id`: `claude-code`
- `source`: `claude-skill`

## Guardrails
- Never run the CLI without showing the JSON first.
- If the batch would create >30 items, ask before proceeding.
- Do not mix `task` and `bug` kinds in one batch unless the user explicitly asks for it.
- Batch is **create-only and not idempotent** — re-running the same payload creates a new epic and new tasks with new UUIDs. Warn the user before re-running.

## Atomicity
If any single row fails validation (bad type, empty title, unknown key), the CLI exits with a single aggregated error message and writes **nothing** to the inbox. Fix the errors and re-run.
