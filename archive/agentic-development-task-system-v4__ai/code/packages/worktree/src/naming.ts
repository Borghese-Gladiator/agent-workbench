/**
 * Pure naming rules for branches and worktree paths. No IO — kept separate so
 * the naming format can be unit-tested without touching git or the filesystem.
 */
import { basename, dirname, join } from 'node:path';

/** Lowercase, hyphen-separated, ascii-only slug. Trimmed to a sane length. */
export function slugify(text: string, maxLen = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'task').slice(0, maxLen).replace(/-+$/g, '');
}

/**
 * Short, collision-resistant suffix derived from the task id. The id is
 * `<prefix>_<nanoid>` (e.g. `task_V1StGXR8Z5`); we keep the last 6 chars of the
 * random part so the branch stays unique without dragging the full id through
 * the readable name.
 */
function shortId(taskId: string): string {
  const rand = taskId.includes('_') ? taskId.slice(taskId.lastIndexOf('_') + 1) : taskId;
  return rand.slice(-6) || taskId;
}

/**
 * Branch name for a task: `<slug>-<short-id>`. The human-readable summary leads
 * so the branch is recognizable at a glance (in `git branch`, PR lists, etc.);
 * a short id suffix keeps it unique across tasks with similar titles. No
 * workbench namespace prefix — the branch reads as a normal repo feature branch.
 */
export function branchFor(taskId: string, title: string): string {
  return `${slugify(title)}-${shortId(taskId)}`;
}

/**
 * Worktree path for a task, derived from the PROJECT's own checkout so the
 * worktree is unambiguously a worktree branched off that project — never nested
 * inside an unrelated repo (e.g. the workbench's own data dir):
 *
 *   `<dirname(repoPath)>/.workbench-worktrees/<repo-basename>/<task-id>-<slug>`
 *
 * i.e. a `.workbench-worktrees` sibling next to the project checkout, scoped by
 * the repo's directory name. `git worktree list` for the project then shows the
 * worktree adjacent to the project, not under another repo's working tree.
 */
export function worktreePathFor(repoPath: string, taskId: string, title: string): string {
  return join(
    dirname(repoPath),
    '.workbench-worktrees',
    basename(repoPath),
    `${taskId}-${slugify(title)}`,
  );
}
