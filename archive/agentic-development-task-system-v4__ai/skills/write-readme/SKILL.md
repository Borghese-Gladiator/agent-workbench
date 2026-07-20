---
name: write-readme
description: Final step of the implementation stage on a brand-new/EMPTY repo — after the code is written, author the repo-root README so a newcomer can understand and run the project. Injected programmatically (only when the repo started empty) as the last instruction of implementation. Documents what the code you just wrote ACTUALLY contains — never invented.
---

# README Writer (final step — new/empty repo)

This is the **last step of implementation**, and it runs only because this repo started
**empty**. You have just written the initial code. Now author a `README.md` at the repo
root so a newcomer can understand what this is and get it running.

Because you just built it, the manifest, scripts, and file tree now **actually exist** —
document what is really there, not what was planned. Do not invent commands, features, or
a project name the code doesn't support.

## Preconditions
- Do this AFTER your implementation work is otherwise complete. Write **only**
  `README.md` at the repo root — do not change source files for the sake of the README.
- The lifecycle only runs this on a repo that started empty, so there is no
  human-written README to protect. Still: if a non-empty README is already present,
  don't clobber it — append/fill gaps instead and note what you found.

## How to write
1. **Document what you actually built.** Read back the manifest you wrote
   (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`,
   `docker-compose.yml`, etc.) and the source tree as it now stands. The README
   describes the real state of the repo at the end of this stage.
2. **Write these REQUIRED sections**, in order:
   - **Title + description** — one or two sentences stating *what this project is* and
     what it does. No marketing; just what a newcomer needs to orient.
   - **Build / install** — the exact command(s) to install dependencies and build the
     project, taken from the scripts you actually wired up (e.g. `pnpm install` +
     `pnpm build`, `poetry install`, `make build`). If there is no build step, say so.
   - **Run (dev)** — the exact command to start the project for local development, with
     hot-reload/watch if you wired one (e.g. `pnpm dev`, `uvicorn app:app --reload`,
     `make dev`). If there is no dev mode, say so — don't repeat the prod command.
   - **Run (prod)** — the exact command to start/serve the project in production — the
     built/optimized entrypoint, distinct from dev (e.g. `pnpm start` after `pnpm build`,
     `gunicorn app:app`, `make run`). If the project has no separate production mode,
     say so explicitly rather than repeating the dev command.
   - **File hierarchy** — a rough tree of the top-level directories/files with a
     one-line note on what each holds. Keep it to the meaningful entries (skip
     `node_modules`, `.git`, build output). A short fenced tree is enough.
3. **Every command must be real — verify it.** Each build/dev/prod command MUST be a
   script/entrypoint that exists in the code you wrote — cite where (e.g. `package.json
   "scripts.dev"`). Where it's cheap and safe, actually RUN the command to confirm it
   works before documenting it. If a category genuinely has no command yet, write a
   one-line `Not yet defined` note rather than inventing one — never guess a command.
4. **Only these sections.** Write ONLY the four sections above — do NOT add Contributing,
   License, Badges, Acknowledgements, or similar boilerplate, even if a LICENSE exists.

## Output
After writing `README.md`, give a short Markdown report: the project description you
landed on, the build / dev / prod commands (with where each was sourced and whether you
ran it), and the file hierarchy you documented. End with the required ```json block:
`{ "readmePath": "README.md", "description": "<one-line>", "buildCommands": ["..."], "devCommands": ["..."], "prodCommands": ["..."], "fileHierarchy": ["<top-level entry>", "..."], "sources": ["package.json scripts.dev", "..."] }`.
`buildCommands`, `devCommands`, and `prodCommands` MUST be real commands from the code you
wrote (or an explicit `Not yet defined` note); `fileHierarchy` MUST list the actual
top-level entries; `sources` MUST cite where each command/claim came from.
