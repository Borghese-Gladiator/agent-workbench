import { and, eq, isNull } from 'drizzle-orm';
import { repositoryFacts, type DrizzleDb, type RepositoryFactRow } from '@awb/database';
import type { RepositoryFact } from '@awb/domain';

/**
 * The project-memory lifecycle: what earns a row, and when a row stops counting (TASK-116).
 * The rules and their reasoning are ADR-010, which extends ADR-009 rather than reopening it —
 * still markdown projected from SQLite, still no graph and no vector store.
 *
 * Before this, memory only ever grew. Nothing said which facts were worth keeping, and nothing
 * said when one had gone stale, so a superseded fact and a current one sat side by side and
 * `queryMemory` handed both to the next planner.
 */

/**
 * How many later recordings an `inferred` fact may go unconfirmed before it is evicted.
 *
 * Only `inferred` decays. A `declared` fact is written down in the repo and a `validated` one was
 * proven by running something — neither stops being true because nobody tripped over it lately.
 * An inference is a guess that nothing has re-confirmed, which is exactly what should age out.
 */
export const STALE_AFTER_OBSERVATIONS = 5;

export interface PromotionVerdict {
  promote: boolean;
  /** Why it was refused, for the caller's log. Empty when promoted. */
  reasons: string[];
}

/**
 * Does this fact earn a place in project memory? (ADR-010 §1)
 *
 * Pure, so the rule is identical in every caller and testable without a database. The bar is
 * deliberately about DURABILITY and PROVENANCE rather than about being interesting: a fact
 * restatable from the code in one grep does not earn a row, because the repo already holds it.
 */
export function qualifiesForPromotion(fact: Pick<RepositoryFact, 'statement' | 'sourcePaths' | 'observedAtSha'>): PromotionVerdict {
  const reasons: string[] = [];
  const statement = fact.statement.trim();

  // Provenance: without it a reader cannot check whether the fact is still true.
  if (fact.sourcePaths.length === 0) reasons.push('no source paths — the fact cannot be re-checked');
  if (fact.observedAtSha.trim().length === 0) reasons.push('no observedAtSha — the fact has no point in time');

  // Falsifiable: vague advice can never be superseded, so it can never be evicted, so it
  // accumulates forever. That is exactly the growth this policy exists to stop.
  //
  // Measured in WORDS, not characters: a character count is an arbitrary instrument that would
  // reject a short, perfectly checkable fact ("uses pnpm workspaces") alongside genuinely
  // contentless text. Three words is the floor for a claim with a subject and a predicate.
  if (statement.split(/\s+/).filter(Boolean).length < MIN_STATEMENT_WORDS) {
    reasons.push('statement is too short to be a falsifiable claim');
  }
  if (VAGUE_PATTERNS.some((pattern) => pattern.test(statement))) {
    reasons.push('statement is advice, not a falsifiable claim about this repository');
  }

  // Outlives the task: run state is not repository knowledge.
  if (RUN_SCOPED_PATTERNS.some((pattern) => pattern.test(statement))) {
    reasons.push('statement describes this run, not the repository');
  }

  return { promote: reasons.length === 0, reasons };
}

const MIN_STATEMENT_WORDS = 3;

/** Hedged, unfalsifiable phrasing. A claim nobody can prove wrong can never be evicted. */
const VAGUE_PATTERNS = [
  /^(?:try|consider|maybe|perhaps|it (?:might|may) be)\b/i,
  /\b(?:be careful|keep in mind|remember to|make sure to)\b/i,
];

/** Phrasing that describes this run rather than the repository. */
const RUN_SCOPED_PATTERNS = [
  /\b(?:this (?:run|task|attempt|session)|slice \d+|attempt \d+)\b/i,
  /\btask-[0-9a-f-]{8,}\b/i,
];

export interface EvictionResult {
  /** Ids superseded because an incoming fact explicitly replaces them. */
  replaced: { factId: string; supersededBy: string }[];
  /** Ids evicted for going unconfirmed past the staleness horizon. */
  stale: string[];
}

/**
 * Applies the eviction rules to one repository's live facts (ADR-010 §2).
 *
 * Eviction is supersession, never deletion: ADR-009 invariant #4 keeps a superseded fact
 * addressable, and the markdown projection keeps rendering it under `## Superseded`. A reader can
 * always see what we used to believe.
 *
 * Replacement is EXPLICIT — an incoming fact names the id it supersedes. An earlier draft matched
 * facts by a bag-of-words "same subject" key instead, and that is the wrong instrument here: a key
 * that guesses will eventually mis-match, and a mis-match silently retires a correct, unrelated
 * fact. Data loss is a far worse failure than a duplicate row, so the caller has to be explicit.
 *
 * `observationsSinceBySubject` counts how many later recordings each live fact id has gone without
 * being re-observed; the caller owns that tally because only it knows what it looked at.
 */
export async function evictSupersededFacts(
  db: DrizzleDb,
  repositoryId: string,
  incoming: { id: string; supersedesFactIds?: string[] }[],
  options: { observationsSinceByFactId?: Map<string, number> } = {},
): Promise<EvictionResult> {
  const live: RepositoryFactRow[] = await db
    .select()
    .from(repositoryFacts)
    .where(and(eq(repositoryFacts.repositoryId, repositoryId), isNull(repositoryFacts.supersededBy)));

  const result: EvictionResult = { replaced: [], stale: [] };
  const liveIds = new Set(live.map((row) => row.id));

  // 1. Explicit replacement.
  const replacedBy = new Map<string, string>();
  for (const fact of incoming) {
    for (const oldId of fact.supersedesFactIds ?? []) {
      // Only a LIVE fact can be superseded, and never by itself — a self-reference would retire
      // the incoming fact the moment it was written.
      if (!liveIds.has(oldId) || oldId === fact.id) continue;
      replacedBy.set(oldId, fact.id);
    }
  }
  for (const [oldId, newId] of replacedBy) {
    await db.update(repositoryFacts).set({ supersededBy: newId }).where(eq(repositoryFacts.id, oldId));
    result.replaced.push({ factId: oldId, supersededBy: newId });
  }

  // 2. Staleness. Only an `inferred` fact decays; see STALE_AFTER_OBSERVATIONS.
  for (const row of live) {
    if (replacedBy.has(row.id)) continue;
    if (row.confidence !== 'inferred') continue;
    const unconfirmed = options.observationsSinceByFactId?.get(row.id) ?? 0;
    if (unconfirmed < STALE_AFTER_OBSERVATIONS) continue;
    await db.update(repositoryFacts).set({ supersededBy: STALE_MARKER }).where(eq(repositoryFacts.id, row.id));
    result.stale.push(row.id);
  }

  return result;
}

/** Marks a fact evicted for going unconfirmed, distinct from one replaced by a named successor. */
export const STALE_MARKER = 'stale';
