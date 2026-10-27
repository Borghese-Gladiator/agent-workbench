---
name: create-epic
description: Create a single epic on the Agent Task System taskboard. Use when the user wants to start a new epic without immediately breaking it into tasks — for epic + tasks in one pass, prefer /bulk-create.
---

Create a single epic on the local taskboard using the ingest CLI.

## When to use
- User asks to create an epic, project, or feature group on the taskboard
- User wants to group related tasks under a parent epic (but isn't ready to define the tasks yet)

If the user is creating the epic **and** its task list in one go, use `/bulk-create` instead — it creates both in a single call and auto-links the tasks to the new epic.

## Steps

1. Gather from the user or conversation context:
   - **title** (required): epic name
   - **description**: what the epic covers
   - **initiative-id**: if user specifies a parent initiative

2. Run the CLI from the project root:
   ```bash
   npx tsx src/cli/ingest.main.ts epic \
     --title "<title>" \
     [--description "<description>"] \
     [--initiative-id <uuid>]
   ```

3. Confirm creation to the user with the entity ID and title.
4. Ask if the user wants to create tasks under this epic — offer `/create-task` for one-off tasks or `/bulk-create` for multiple.
