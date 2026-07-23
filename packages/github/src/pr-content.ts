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
 * `[AWB]` prefix. Takes the first clause (before the first sentence break / em-dash / "e.g."),
 * strips a leading imperative-y preamble, and caps the length. Falls back to a change-area phrase
 * built from the changed paths when the objective yields nothing usable.
 */
export function derivePrTitle(objective: string, changedPaths: string[] = []): string {
  const firstClause = objective
    .split(/(?:\.\s|—|-\s|,\s*e\.g\.|:\s|\se\.g\.)/i)[0]
    ?.trim()
    .replace(/\s+/g, ' ');

  let title = firstClause ?? '';
  // Drop a leading "In <file/area>, " scoping preamble the planner/objective often carries.
  title = title.replace(/^in\s+[^,]+,\s*/i, '');
  // Sentence-case the first letter without lowercasing acronyms.
  if (title.length > 0) title = title[0]!.toUpperCase() + title.slice(1);

  if (title.length === 0) {
    const area = changeAreaLabel(changedPaths);
    title = area ? `Update ${area}` : 'Automated change';
  }

  if (title.length > TITLE_MAX) {
    title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  }
  return title;
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
 * A descriptive brief for a QA-media artifact posted as a PR comment (replaces the bare
 * "QA artifact (qa-video): <url>"). Describes what was exercised + the result, then links the
 * recording. `mediaUrl` may be undefined when the upload failed — the caller decides whether to
 * post at all; this only formats.
 */
export function renderQaMediaBrief(input: {
  kind: string;
  qaSummary?: string;
  mediaUrl?: string;
}): string {
  const label = input.kind === 'qa-video' ? 'Browser QA recording' : input.kind === 'browser-trace' ? 'Browser QA trace' : input.kind;
  const what = input.qaSummary?.trim() || 'Exercised the changed behavior in a real browser.';
  const link = input.mediaUrl ? `\n\n[▶ ${label}](${input.mediaUrl})` : '';
  return `**${label}** — ${what}${link}`;
}
