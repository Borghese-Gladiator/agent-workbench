const MAX_SLUG_LENGTH = 40;

function slugify(source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'task';
}

/**
 * Derives the branch name for a task's workspace: `awb/<slug>-<shortId>`. The slug is a
 * human-readable hint from the task's prompt/objective (kebab-case, truncated) and comes FIRST so
 * the branch reads sanely (e.g. `awb/portal-header-subtitle-game-count-ecabb015`); a short
 * taskId suffix preserves uniqueness without dumping the full UUID (twice) into the name.
 */
export function resolveTaskBranchName(taskId: string, slugSource: string): string {
  const shortId = taskId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'task';
  return `awb/${slugify(slugSource)}-${shortId}`;
}
