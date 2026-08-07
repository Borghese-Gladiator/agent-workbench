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
 * Splits an "In <scope>, <action>" objective into its scope and action clauses. Returns
 * `undefined` when there is no such preamble. Shared by the title path (which may render the scope
 * as a prefix) and the branch-name path (which slugifies only the action, dropping the preamble).
 */
export function parseScopePreamble(objective: string): { scope: string; action: string } | undefined {
  const first = objective
    .split(/(?:\.\s|—|-\s|,\s*e\.g\.|\se\.g\.)/i)[0]
    ?.trim()
    .replace(/\s+/g, ' ');
  const scoped = /^in\s+(?:the\s+)?([^,]+?),\s*(.+)$/i.exec(first ?? '');
  if (!scoped) return undefined;
  return { scope: scoped[1]!.trim(), action: scoped[2]!.trim() };
}

/**
 * Returns the objective with any leading "In <scope>, " preamble stripped — i.e. the bare action
 * clause. When there is no preamble, returns the first clause of the objective unchanged. Used to
 * derive a clean branch slug (`awb/add-a-one-line-note-…`, not `awb/in-wip-browser-games-…`).
 */
export function stripScopePreamble(objective: string): string {
  const parsed = parseScopePreamble(objective);
  if (parsed) return parsed.action;
  return (
    objective
      .split(/(?:\.\s|—|-\s|,\s*e\.g\.|\se\.g\.)/i)[0]
      ?.trim()
      .replace(/\s+/g, ' ') ?? objective
  );
}

/**
 * Derives a SHORT, brief PR title from the objective — NOT the whole request sentence, and with no
 * `[AWB]` prefix. Keeps the SCOPE and the ACTION: when the objective opens with an "In <scope>,
 * <action>" preamble (common), it becomes "<Scope>: <action>" — UNLESS the scope is just the target
 * repo's own name (GitHub already shows the repo, so a "Wip-Browser-Games:" prefix is noise), in
 * which case we drop the scope and keep the plain action. Otherwise takes the first clause. Falls
 * back to a change-area phrase from the changed paths when the objective yields nothing.
 */
export function derivePrTitle(objective: string, changedPaths: string[] = [], repo?: string): string {
  const parsed = parseScopePreamble(objective);

  let title: string;
  if (parsed) {
    if (repo && scopeIsRepoName(parsed.scope, repo)) {
      // Scope adds nothing over GitHub's own repo label — use the bare action.
      title = parsed.action[0]!.toUpperCase() + parsed.action.slice(1);
    } else {
      title = `${titleCase(parsed.scope)}: ${parsed.action}`;
    }
  } else {
    const firstSentence =
      objective
        .split(/(?:\.\s|—|-\s|,\s*e\.g\.|\se\.g\.)/i)[0]
        ?.trim()
        .replace(/\s+/g, ' ') ?? '';
    title = firstSentence.length > 0 ? firstSentence[0]!.toUpperCase() + firstSentence.slice(1) : '';
  }

  if (title.length === 0) {
    const area = changeAreaLabel(changedPaths);
    title = area ? `Update ${area}` : 'Automated change';
  }

  return truncateOnWordBoundary(title, TITLE_MAX);
}

/** True when the "In <scope>," scope resolves to (or contains) the target repo's name. */
function scopeIsRepoName(scope: string, repo: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const s = norm(scope);
  const r = norm(repo);
  return s === r || s.includes(r) || r.includes(s);
}

/**
 * Truncates to at most `max` chars, cutting on a word boundary (never mid-token) and appending an
 * ellipsis only when something was actually dropped. The ellipsis counts toward `max`.
 */
function truncateOnWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const head = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  return `${head.trimEnd()}…`;
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
 *   - screenshot     → inline image via the raw URL (also opens in a tab)
 *   - qa-video-gif   → inline animated GIF via the raw URL (GitHub renders it in the comment — the
 *                      primary recording artifact)
 *   - qa-video       → secondary "full recording (WEBM)" link; GitHub does NOT play a committed
 *                      .webm inline, so the blob-view player is only a fallback when no GIF exists
 *   - browser-trace  → release-asset download link (no in-browser viewer exists; needs
 *                      `npx playwright show-trace`)
 * The GIF (when present) is rendered inline and the WEBM demoted to a secondary link; without a GIF
 * the WEBM keeps its blob-view link. Returns '' when there is nothing to show.
 */
export function renderQaMediaSection(input: {
  ref: { owner: string; repo: string };
  branch: string;
  qaSummary?: string;
  items: QaMediaItem[];
}): string {
  const { owner, repo } = input.ref;
  const gif = input.items.find((i) => i.kind === 'qa-video-gif' && i.repoPath);
  const webm = input.items.find((i) => i.kind === 'qa-video' && i.repoPath);

  const lines: string[] = [];
  for (const item of input.items) {
    if (item.kind === 'screenshot' && item.repoPath) {
      lines.push(`**Screenshot**`, '', `![Browser QA screenshot](${rawContentUrl(owner, repo, input.branch, item.repoPath)})`);
    } else if (item.kind === 'qa-video-gif' && item.repoPath) {
      // Primary recording: inline animated GIF (renders in the comment) + the WEBM as a secondary
      // full-fidelity link.
      lines.push(`**Recording**`, '', `![Browser QA recording](${rawContentUrl(owner, repo, input.branch, item.repoPath)})`);
      if (webm?.repoPath) {
        lines.push('', `[⬇ Full recording (WEBM)](${blobViewUrl(owner, repo, input.branch, webm.repoPath)})`);
      }
    } else if (item.kind === 'qa-video' && item.repoPath) {
      // Only a bare WEBM link when there is no GIF to embed (fallback).
      if (!gif) {
        lines.push(`**Recording** — [▶ Watch recording (opens in a tab)](${blobViewUrl(owner, repo, input.branch, item.repoPath)})`);
      } else {
        continue; // Rendered above as the GIF's secondary link.
      }
    } else if (item.kind === 'browser-trace' && item.downloadUrl) {
      lines.push(
        `**Playwright trace** — [⬇ Download trace](${item.downloadUrl}) · view with \`npx playwright show-trace <file>\``,
      );
    } else {
      continue;
    }
    lines.push('');
  }
  if (lines.length === 0) return '';

  const what = input.qaSummary?.trim() || 'Exercised the changed behavior in a real browser.';
  return [`## Browser QA`, '', what, '', ...lines].join('\n').trimEnd();
}
