import type Database from 'better-sqlite3';
import type { DrizzleDb } from '@awb/database';
import type { RepositoryFact } from '@awb/domain';
import type { CompleteFn } from './compile.js';
import { queryMemory } from './query.js';

/** A flagged pair of facts the model judged mutually contradictory. */
export interface Contradiction {
  factIds: [string, string];
  reason: string;
}

/** A suggested new link between two existing facts (advisory — not applied to the store). */
export interface ConnectionCandidate {
  factIds: [string, string];
  reason: string;
}

export interface LintReport {
  contradictions: Contradiction[];
  /** Ids of facts the model judged stale/superseded by newer facts. */
  staleFactIds: string[];
  connectionCandidates: ConnectionCandidate[];
}

/** The raw shape the model is asked to return; ids are validated against the real fact set. */
interface LintDraft {
  contradictions?: { factIds?: string[]; reason?: string }[];
  staleFactIds?: string[];
  connectionCandidates?: { factIds?: string[]; reason?: string }[];
}

function buildPrompt(facts: RepositoryFact[]): string {
  const lines = facts.map((f) => `${f.id} (${f.kind}, ${f.confidence}): ${f.statement}`).join('\n');
  return [
    'You are health-checking a repository knowledge base. Each line is "<id> (<kind>, <confidence>): <statement>".',
    'Find (a) pairs that contradict each other, (b) facts that are stale/superseded by a newer fact,',
    '(c) pairs that are strongly related and should be linked.',
    'Respond with a single JSON object and nothing else. Use ONLY ids that appear below:',
    '{ "contradictions": [{ "factIds": ["<id>","<id>"], "reason": "<why>" }],',
    '  "staleFactIds": ["<id>"],',
    '  "connectionCandidates": [{ "factIds": ["<id>","<id>"], "reason": "<why>" }] }',
    '',
    'Facts:',
    lines,
  ].join('\n');
}

function parse(raw: string): LintDraft | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as LintDraft;
  } catch {
    return undefined;
  }
}

function pair(ids: string[] | undefined, valid: Set<string>): [string, string] | undefined {
  if (!ids || ids.length !== 2) return undefined;
  const a = ids[0];
  const b = ids[1];
  if (a === undefined || b === undefined || a === b || !valid.has(a) || !valid.has(b)) return undefined;
  return [a, b];
}

/**
 * Lint pass (Karpathy KB workflow, TASK-50). Reads a repository's live facts and asks the model to
 * flag contradictions, stale/superseded facts, and new-connection candidates. Returns a structured
 * REPORT only — it never mutates the store (no auto-invalidation). Ids in the report are validated
 * against the real fact set, so a hallucinated id is dropped rather than surfaced. Md-first, advisory
 * (see ADR-009); feeding confirmed contradictions into `invalidateFacts` is left to the caller.
 */
export async function lintMemory(
  db: DrizzleDb,
  sqlite: Database.Database,
  repositoryId: string,
  complete: CompleteFn,
): Promise<LintReport> {
  const facts = await queryMemory(db, sqlite, repositoryId, {});
  const empty: LintReport = { contradictions: [], staleFactIds: [], connectionCandidates: [] };
  if (facts.length === 0) return empty;

  const draft = parse(await complete(buildPrompt(facts)));
  if (!draft) return empty;

  const valid = new Set(facts.map((f) => f.id));

  const contradictions: Contradiction[] = [];
  for (const c of draft.contradictions ?? []) {
    const ids = pair(c.factIds, valid);
    if (ids) contradictions.push({ factIds: ids, reason: c.reason ?? '' });
  }

  const connectionCandidates: ConnectionCandidate[] = [];
  for (const c of draft.connectionCandidates ?? []) {
    const ids = pair(c.factIds, valid);
    if (ids) connectionCandidates.push({ factIds: ids, reason: c.reason ?? '' });
  }

  const staleFactIds = (draft.staleFactIds ?? []).filter((id) => valid.has(id));

  return { contradictions, staleFactIds, connectionCandidates };
}
