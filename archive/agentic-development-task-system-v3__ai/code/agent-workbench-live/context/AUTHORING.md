# Context authoring

Applies when: adding, splitting, or editing a file under `agent-workbench-live/context/`.

Do:

- Keep each file to one screen (~50 lines, 60 hard).
- Cover one concern per file. If two concerns are creeping in, split.
- Lead with examples; prose is the last resort.
- Pick one default ("Poetry + pytest", not "depends on the project"). "It depends" is a smell.
- Use the four-marker template literally: `Applies when:` / `Do:` / `Do not:` / `Commands:`.
- Add an entry to `@context/README.md` whenever you add a file.
- Name files in lowercase kebab-case (`draft-pr.md`, not `DraftPR.md`).
- Compose, don't duplicate: if two contexts share guidance, factor it into a shared leaf and reference it from both.

Do not:

- Do not write workflows here. Workflows go in `.claude/commands/*.md` and import the context files they need.
- Do not turn a context file into a tutorial. Three bullets > one paragraph.
- Do not assume tools the target repo doesn't already use.
- Do not inline a slash command's full body into a context file.

Commands:

```bash
# Sanity-check a new file you just authored.
wc -l agent-workbench-live/context/path/to/new-file.md
grep -E '^(Applies when:|Do:|Do not:|Commands:)' agent-workbench-live/context/path/to/new-file.md
```
