---
name: create-task
description: Create a single task or bug on the Agent Task System taskboard. Defaults to kind=task, status=triage. Use when the user asks for one task or bug — for 3+ items, prefer /bulk-create.
---

Create one work item on the local taskboard using the ingest CLI.

## When to use
- User asks to create a single task, ticket, or work item on the taskboard
- User asks to file a bug (pass `--kind bug`)
- User says "add this to the board" for a single item

For batches of tasks (3+ items or a phased breakdown), use `/bulk-create` instead.

## Steps

1. Gather from the user or conversation context:
   - **title** (required): concise summary of the work
   - **body**: detailed description (default: empty)
   - **kind**: "task" (default) or "bug" (only if user explicitly says bug)
   - **epic-id**: if user specifies an epic, look it up
   - **tags**: any relevant tags
   - **acceptance-criteria**: if provided

2. Run the CLI from the project root:
   ```bash
   npx tsx src/cli/ingest.main.ts task \
     --title "<title>" \
     --body "<body>" \
     --kind <task|bug> \
     [--epic-id <uuid>] \
     [--tags <tag1,tag2>] \
     [--acceptance-criteria "<criteria>"] \
     [--lane <frontend|backend|infra|db|docs|test>] \
     [--sort-order <int>] \
     [--depends-on-id <uuid>]
   ```

**Extras:**
- `--lane` groups cards visually on the board (colored left border + lane filter). Free-form string; keep to the short vocabulary above when possible.
- `--sort-order` places this card among its column peers. Cards use a 10-step sequence by default (0, 10, 20…), so pick something between two neighbors to slot it in.
- `--depends-on-id` makes this card "waiting" until the referenced work item reaches `done`.

3. Confirm creation to the user with the entity ID and title.

## Defaults
- kind: task (ONLY use bug if user explicitly asks for a bug)
- status: triage (always — new items go through triage)
- actor-id: claude-code
- source: claude-skill
