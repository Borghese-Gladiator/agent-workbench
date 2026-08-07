import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DrizzleDb } from '@awb/database';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { queryMemory } from './query.js';

/**
 * A single-turn text completion. Injected so compile is testable with a fake and the CLI can wire
 * the real provider (`ClaudeQueryFn` + `contextPreamble`) without this package depending on the
 * agent gateway. Given a prompt, return the model's text response.
 */
export type CompleteFn = (prompt: string) => Promise<string>;

export interface CompileOptions {
  /** Only cluster facts whose source paths share a directory; clusters below this size are left as-is. */
  minClusterSize?: number;
  /** Cap on clusters compiled in one pass (keeps the model spend bounded). */
  maxClusters?: number;
}

export interface CompileResult {
  /** The concept facts written this pass. */
  concepts: RepositoryFact[];
  /** How many atomic facts were folded into those concepts. */
  compactedFrom: number;
}

/** The shape we ask the model to return per cluster (schema-constrained by the prompt). */
interface ConceptDraft {
  title: string;
  statement: string;
  backlinks?: string[];
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** Groups facts by the common directory of their first source path — a cheap, deterministic clustering. */
function clusterByDirectory(facts: RepositoryFact[]): Map<string, RepositoryFact[]> {
  const clusters = new Map<string, RepositoryFact[]>();
  for (const fact of facts) {
    const key = dirOf(fact.sourcePaths[0] ?? '');
    const bucket = clusters.get(key);
    if (bucket) bucket.push(fact);
    else clusters.set(key, [fact]);
  }
  return clusters;
}

function buildPrompt(dir: string, facts: RepositoryFact[]): string {
  const factLines = facts.map((f) => `- (${f.kind}) ${f.statement}`).join('\n');
  return [
    `You are compiling a repository knowledge base. Below are atomic facts sourced from "${dir || '(repo root)'}".`,
    'Synthesize them into ONE dense concept summary that removes duplication and reads as a short wiki entry.',
    'Respond with a single JSON object and nothing else:',
    '{ "title": "<short concept title>", "statement": "<2-4 sentence synthesis>", "backlinks": ["<related concept title>", ...] }',
    '',
    'Facts:',
    factLines,
  ].join('\n');
}

/** Parses the model's JSON reply, tolerating a ```json fence or surrounding prose. */
function parseConcept(raw: string): ConceptDraft | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as ConceptDraft;
    if (typeof parsed.statement !== 'string' || parsed.statement.trim() === '') return undefined;
    if (typeof parsed.title !== 'string' || parsed.title.trim() === '') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Unions the source provenance of a cluster, de-duplicating paths and keeping each path's hash. */
function unionProvenance(facts: RepositoryFact[]): { paths: string[]; hashes: string[] } {
  const byPath = new Map<string, string>();
  for (const fact of facts) {
    fact.sourcePaths.forEach((path, i) => {
      if (!byPath.has(path)) byPath.set(path, fact.sourceHashes[i] ?? '');
    });
  }
  return { paths: [...byPath.keys()], hashes: [...byPath.values()] };
}

/**
 * Compile pass (Karpathy KB workflow, TASK-50). Reads a repository's live atomic facts, clusters
 * them by source directory, and asks the model to synthesize each cluster into one denser
 * `kind: 'concept'` fact — preserving the union of the cluster's provenance (sourcePaths/sourceHashes)
 * so a compiled concept is still traceable to its sources. Purely additive: it appends concept facts
 * and never mutates or deletes the atomic ones. Md-first — no graph store (see ADR-009).
 */
export async function compileConcepts(
  db: DrizzleDb,
  sqlite: Database.Database,
  repositoryId: string,
  complete: CompleteFn,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const minClusterSize = options.minClusterSize ?? 2;

  // Only compile atomic facts — never re-compile prior concept output.
  const facts = (await queryMemory(db, sqlite, repositoryId, {})).filter((f) => f.kind !== 'concept');
  const clusters = [...clusterByDirectory(facts).entries()].filter(([, group]) => group.length >= minClusterSize);
  const limited = options.maxClusters ? clusters.slice(0, options.maxClusters) : clusters;

  const concepts: RepositoryFact[] = [];
  let compactedFrom = 0;

  for (const [dir, group] of limited) {
    const draft = parseConcept(await complete(buildPrompt(dir, group)));
    if (!draft) continue;
    const { paths, hashes } = unionProvenance(group);
    const backlinkSuffix =
      draft.backlinks && draft.backlinks.length > 0 ? ` [[${draft.backlinks.join(']] [[')}]]` : '';
    concepts.push({
      id: randomUUID(),
      repositoryId,
      kind: 'concept',
      statement: `${draft.title}: ${draft.statement}${backlinkSuffix}`,
      confidence: 'inferred',
      // Concepts inherit the latest observed sha among their sources so recency sorting stays sane.
      observedAtSha: group.map((f) => f.observedAtSha).sort().at(-1) ?? '',
      sourcePaths: paths,
      sourceHashes: hashes,
      invalidatedByPaths: paths,
    });
    compactedFrom += group.length;
  }

  if (concepts.length > 0) {
    await recordFacts(db, repositoryId, concepts);
  }
  return { concepts, compactedFrom };
}
