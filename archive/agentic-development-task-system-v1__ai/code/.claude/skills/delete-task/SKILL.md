---
name: delete-task
description: Delete a task (work item) from the Agent Task System taskboard by UUID. Use when the user asks to remove, delete, or cancel a task on the board.
---

Delete a work item from the local taskboard using the ingest CLI.

## When to use
- User asks to delete, remove, or scrap a task by name or UUID
- User says "get this off the board" for a specific task
- User wants to clean up a stale / obsolete task

## Steps

1. Identify the work item UUID:
   - If the user provides a UUID, use it directly.
   - If the user refers to a task by title, ask which one (or list candidates from `data/ingest/processed/` if unambiguous).

2. Confirm with the user before deleting. Deletions are create-only-style events — the CLI writes a `work_item.deleted` envelope that the server processes. Show the UUID and title you're about to delete and wait for confirmation.

3. Run the CLI from the project root:
   ```bash
   npx tsx src/cli/ingest.main.ts delete-task --work-item-id <uuid>
   ```

4. Report the result (file path + event_type from the CLI's JSON output).

## Guardrails
- Never delete without showing the UUID and (ideally) the title to the user first.
- If the user asks to delete multiple tasks, ask whether `/bulk-create`-style bulk-delete is wanted — today the CLI is one-at-a-time; surface that limitation rather than silently loop.
