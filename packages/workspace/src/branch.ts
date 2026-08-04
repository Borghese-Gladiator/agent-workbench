const MAX_SLUG_LENGTH = 40;

/**
 * Strips a leading "In <scope>, " preamble from a prompt/objective, returning the bare action
 * clause. Mirrors the title path's preamble handling (`@awb/github` `stripScopePreamble`) so the
 * branch slug reads `awb/add-a-one-line-note-…` rather than leading with `in-<repo>-` filler. Kept
 * local to avoid a `@awb/workspace → @awb/github` dependency.
 */
function stripScopePreamble(source: string): string {
  const match = /^in\s+(?:the\s+)?[^,]+?,\s*(.+)$/i.exec(source.trim());
  return match ? match[1]!.trim() : source;
}

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
  return `awb/${slugify(stripScopePreamble(slugSource))}-${shortId}`;
}
