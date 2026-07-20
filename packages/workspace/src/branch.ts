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
 * Derives the branch name for a task's workspace: `awb/<taskId>-<slug>`. The taskId already
 * guarantees uniqueness across tasks; the slug is a short human-readable hint derived from the
 * task's prompt/objective (kebab-case, alphanumeric-only, truncated) and is not itself relied on
 * for uniqueness.
 */
export function resolveTaskBranchName(taskId: string, slugSource: string): string {
  return `awb/${taskId}-${slugify(slugSource)}`;
}
