import type { Evidence } from '@awb/domain';

/**
 * Structured inputs for a PR's title + body. Kept provider-neutral (plain data), so the same
 * rendering is used for the real Octokit client and the in-memory fake.
 */
export interface PrContentInput {
  /** The task's objective (the human's request) — the "why" for the Background section. */
  objective: string;
  /** The planner's one-line summary of the approach, if any. */
  planSummary?: string;
  /** Repo-relative paths the candidate diff touched. */
  changedPaths: string[];
  /** Verification + QA evidence, used to render the Test plan section. */
  evidence: Evidence[];
  /** Short candidate SHA, surfaced in the body footer. */
  candidateSha: string;
}

const TITLE_MAX = 72;

/**
 * Derives a SHORT, brief PR title from the objective — NOT the whole request sentence, and with no
 * `[AWB]` prefix. Keeps the SCOPE and the ACTION: when the objective opens with an "In <scope>,
 * <action>" preamble (common), it becomes "<Scope>: <action>" (e.g. "Portal header subtitle: show
 * the number of available games") rather than dropping the scope. Otherwise takes the first clause.
 * Falls back to a change-area phrase from the changed paths when the objective yields nothing.
 */
export function derivePrTitle(objective: string, changedPaths: string[] = []): string {
  const firstSentence = objective
    .split(/(?:\.\s|—|-\s|,\s*e\.g\.|\se\.g\.)/i)[0]
    ?.trim()
    .replace(/\s+/g, ' ');

  let title = firstSentence ?? '';

  // Preserve an "In <scope>, <action>" preamble as a "Scope: action" title, rather than deleting
  // the scope (which loses the crucial "where" context).
  const scoped = /^in\s+(?:the\s+)?([^,]+?),\s*(.+)$/i.exec(title);
  if (scoped) {
    const scope = titleCase(scoped[1]!.trim());
    const action = scoped[2]!.trim();
    title = `${scope}: ${action}`;
  } else if (title.length > 0) {
    title = title[0]!.toUpperCase() + title.slice(1);
  }

  if (title.length === 0) {
    const area = changeAreaLabel(changedPaths);
    title = area ? `Update ${area}` : 'Automated change';
  }

  if (title.length > TITLE_MAX) {
    title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  }
  return title;
}

/** Capitalizes the first letter of each word (for the scope segment of a title). */
function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A short human label for the area the diff touched (e.g. "portal", "packages/engines/president"). */
function changeAreaLabel(changedPaths: string[]): string | undefined {
  if (changedPaths.length === 0) return undefined;
  const topDirs = [...new Set(changedPaths.map((p) => p.split('/').slice(0, 2).join('/')))];
  return topDirs.slice(0, 2).join(', ');
}

/**
 * Renders a real PR description from a template: Background (why), Changes (what — plan summary +
 * touched files), Test plan (how it was verified — the evidence, as prose rows). Replaces the old
 * one-line "Automated draft PR produced by the Agentic Workbench." body and folds in what used to
 * be a separate, non-actionable "evidence matrix" comment.
 */
export function renderPrBody(input: PrContentInput): string {
  const changes: string[] = [];
  if (input.planSummary && input.planSummary.trim().length > 0) {
    changes.push(input.planSummary.trim());
  }
  if (input.changedPaths.length > 0) {
    changes.push('', 'Files changed:', ...input.changedPaths.map((p) => `- \`${p}\``));
  }
  if (changes.length === 0) changes.push('_No structured change summary was recorded._');

  return [
    '## Background',
    '',
    input.objective.trim() || '_No objective recorded._',
    '',
    '## Changes',
    '',
    ...changes,
    '',
    '## Test plan',
    '',
    renderTestPlan(input.evidence),
    '',
    '---',
    `<sub>Delivered by the Agentic Workbench · candidate \`${input.candidateSha.slice(0, 12)}\`</sub>`,
  ].join('\n');
}

/** The Test plan section: one readable line per evidence record, grouped pass/fail, no raw claim ids. */
function renderTestPlan(evidence: Evidence[]): string {
  if (evidence.length === 0) return '_No verification evidence was recorded._';
  const icon = (status: Evidence['status']): string =>
    status === 'passed' ? '✅' : status === 'failed' ? '❌' : '⚠️';
  return evidence.map((e) => `- ${icon(e.status)} **${e.kind}** — ${e.summary}`).join('\n');
}

/**
 * The `raw.githubusercontent.com` URL for a file committed to a branch. Serves an image with its
 * real content-type and NO attachment disposition, so cmd+click opens it viewable in a tab.
 */
export function rawContentUrl(owner: string, repo: string, branch: string, repoPath: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${repoPath}`;
}

/**
 * The GitHub blob-view URL for a file committed to a branch. For a committed video this page renders
 * GitHub's native inline <video> player — cmd+click opens it and plays in a tab (no download), which
 * the raw URL cannot do for video (raw serves video as an attachment).
 */
export function blobViewUrl(owner: string, repo: string, branch: string, repoPath: string): string {
  return `https://github.com/${owner}/${repo}/blob/${branch}/${repoPath}`;
}

export interface QaMediaItem {
  kind: string;
  /** Repo-relative path of the media committed to the PR branch (screenshot + video). */
  repoPath?: string;
  /** Release-asset download URL (used for the trace zip, which has no in-browser viewer). */
  downloadUrl?: string;
}

/**
 * One consolidated QA-media section for a PR comment. Each artifact links to a form the reviewer can
 * open WITHOUT a local download where GitHub allows it:
 *   - screenshot   → inline image via the raw URL (also opens in a tab)
 *   - qa-video     → GitHub blob-view player via the blob URL ("Watch recording (opens in tab)")
 *   - browser-trace→ release-asset download link (no in-browser viewer exists; needs
 *                    `npx playwright show-trace`)
 * Returns '' when there is nothing to show.
 */
export function renderQaMediaSection(input: {
  ref: { owner: string; repo: string };
  branch: string;
  qaSummary?: string;
  items: QaMediaItem[];
}): string {
  const { owner, repo } = input.ref;
  const lines: string[] = [];
  for (const item of input.items) {
    if (item.kind === 'screenshot' && item.repoPath) {
      lines.push(`**Screenshot**`, '', `![Browser QA screenshot](${rawContentUrl(owner, repo, input.branch, item.repoPath)})`);
    } else if (item.kind === 'qa-video' && item.repoPath) {
      lines.push(`**Recording** — [▶ Watch recording (opens in a tab)](${blobViewUrl(owner, repo, input.branch, item.repoPath)})`);
    } else if (item.kind === 'browser-trace' && item.downloadUrl) {
      lines.push(
        `**Playwright trace** — [⬇ Download trace](${item.downloadUrl}) · view with \`npx playwright show-trace <file>\``,
      );
    }
    lines.push('');
  }
  if (lines.length === 0) return '';

  const what = input.qaSummary?.trim() || 'Exercised the changed behavior in a real browser.';
  return [`## Browser QA`, '', what, '', ...lines].join('\n').trimEnd();
}
