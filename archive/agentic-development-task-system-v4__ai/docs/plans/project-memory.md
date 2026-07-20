# Per-project memory (append-only decision log)

## Brief
Every task that reaches closeout appends ONE entry of durable decisions
(architectural / implementation / naming / convention + the "why") to a single
per-project file. New tasks read that file during `discovery` and
`options_plan_test` so they start knowing what the project already decided,
instead of re-deriving it.

- Storage: `data/project-memory/<projectId>.md` — one append-only markdown file
  per project. NO DB migration (the path is derived from `projectId`).
- Content: durable decisions only (no per-task summaries, no raw artifact dump).
- Write seam: `closeout()` (`apps/daemon/src/service.ts`).
- Read seam: a new `## Project memory` prompt section for `discovery` +
  `options_plan_test`, alongside the existing `## Prior context`.

This closes the loop the workbench is missing: closeout WRITES the decision log,
the next task's discovery/planning READS it. It reuses the inline-bodies prompt
mechanism (the turn-explosion fix), just project-scoped instead of task-scoped.

## Changes
1. `packages/store/src/project-memory-files.ts` (new): `ProjectMemoryStore`
   mirroring `ArtifactFileStore` — `read(projectId)` and `append(projectId, entry)`.
   File lives under `<dataDir>/project-memory/<projectId>.md`. First write seeds a
   header. `Store` constructs it from a new `projectMemoryDir` option and exposes
   `readProjectMemory` / `appendProjectMemory`.
2. `apps/daemon/src/paths.ts`: `PROJECT_MEMORY_DIR = <DATA_DIR>/project-memory`.
   Wire into the `Store` construction in `main.ts`.
3. `packages/agents/src/index.ts`:
   - `AgentRunInput.promptOverride?: string` — when set, the claude adapter sends
     it verbatim (same path as `resume.message`) instead of `claudeStagePrompt`.
     Lets the summarizer run a one-shot agent WITHOUT adding a lifecycle Stage.
   - `AgentRunInput.projectMemory?: string` — resolved memory body, rendered as a
     `## Project memory` section (distinct framing from `## Prior context`).
   - `MEMORY_STAGES = {discovery, options_plan_test}` gate for which stages get it.
4. `packages/agents/src/claude.ts`: honor `promptOverride` at the two prompt-build
   sites (`input.resume ? resume.message : input.promptOverride ?? claudeStagePrompt`).
5. `apps/daemon/src/service.ts`:
   - `resolveStageContext` callers also pass `projectMemory` for memory stages.
   - `closeout()` → after the terminal transition, fire `appendTaskMemory(task)`:
     on the claude runtime, run a one-shot summarizer (durable artifacts inlined
     via `promptOverride`) that emits a decision entry; append it. On mock, append
     a deterministic stub. Best-effort: a summarizer failure MUST NOT fail closeout.

## Tests
### unit
- `project-memory-files.test.ts`: append seeds header once; second append keeps the
  header and both entries in order; `read` of an unknown project returns ''.
- `index.test.ts`: `claudeStagePrompt` renders `## Project memory` only when
  `projectMemory` is set; `promptOverride` is honored (claude adapter sends it).
- `service` test: closeout on a mock project appends an entry to the project
  memory file; a NEW task's discovery prompt for that project includes the entry;
  a summarizer throw does not throw out of `closeout`.

### manual
- python/script: drive a task end-to-end on the mock runtime, assert
  `data/project-memory/<projectId>.md` grows by one entry, then start a second
  task and confirm its discovery stage prompt carries the memory section.
- (claude runtime, live) confirm the summarizer entry is actually durable
  decisions, not a task recap — content quality only verifiable live.
