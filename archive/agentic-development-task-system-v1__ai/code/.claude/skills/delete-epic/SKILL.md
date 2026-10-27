---
name: delete-epic
description: Delete an epic from the Agent Task System taskboard by UUID. Use when the user asks to remove, delete, or scrap an epic on the board.
---

Delete an epic from the local taskboard using the ingest CLI.

## When to use
- User asks to delete, remove, or scrap an epic by name or UUID
- User wants to clean up an obsolete or cancelled epic

## Steps

1. Identify the epic UUID:
   - If the user provides a UUID, use it directly.
   - If the user refers to an epic by title, ask which one.

2. Confirm with the user before deleting. **Deleting an epic may orphan tasks linked to it** — check whether any work items still reference this `epic_id` and surface that to the user before running the CLI.

3. Run the CLI from the project root:
   ```bash
   npx tsx src/cli/ingest.main.ts delete-epic --epic-id <uuid>
   ```

4. Report the result (file path + event_type from the CLI's JSON output).

## Guardrails
- Never delete without showing the UUID and (ideally) the title to the user first.
- Flag any tasks that would be orphaned. Offer `/delete-task` for each if the user wants them gone too.
