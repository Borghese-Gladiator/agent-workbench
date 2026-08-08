import type { TaskSize } from '@awb/domain';

/**
 * A bounded set of reason codes the size classifier may cite (TASK-51). Constrained rather than
 * free-text so classifier behavior is inspectable and the shadow-evaluation log (TASK-61) can bucket
 * decisions by cause. Advisory — never gates anything.
 */
export const SIZE_REASON_CODES = [
  'atomic_local_change',
  'obvious_validation',
  'multiple_steps',
  'scope_uncertain',
  'design_choice',
  'cross_system',
  'public_contract',
  'data_migration',
  'security_sensitive',
  'rollout_or_rollback',
] as const;
export type SizeReasonCode = (typeof SIZE_REASON_CODES)[number];

export interface SizeClassification {
  size: TaskSize;
  reasonCodes: SizeReasonCode[];
}

/**
 * What the classifier sees. Just the prompt today; an optional `repositoryContext` string is reserved
 * for a future cheap discovery pass (resolved files / callers / affected boundaries) — kept as free
 * text so we can grow the evidence without a schema commitment.
 */
export interface SizingInput {
  prompt: string;
  repositoryContext?: string;
}

/**
 * The instruction handed to the size classifier (TASK-51). It teaches the model WHAT small / medium /
 * large tasks look like — task characteristics + worked examples — and lets it judge the arbitrary
 * instruction, rather than describing our phase machinery. `M` is the "when unsure" default so an
 * uncertain task is never single-shotted (S) nor over-planned (L) on a guess.
 */
export function sizingInstruction(input: SizingInput): string {
  return [
    'You classify a software-engineering task as S, M, or L by how much up-front planning it warrants.',
    'Judge the WORK the task implies, not how it is phrased.',
    '',
    'S — small:',
    '- Concrete, atomic, locally scoped; one obvious implementation direction.',
    '- No meaningful design decision; no public contract, schema, security, or persistence boundary.',
    '- Validation is obvious and local.',
    '- Examples: fix a typo, tweak copy, add a config value, implement one well-specified helper.',
    '',
    'M — medium (use this when the evidence does not clearly support S or L):',
    '- Bounded work that benefits from an ordered plan: several coordinated edits in one area.',
    '- No architectural, migration, or cross-system decision required.',
    '- Examples: add a field end-to-end within one package, add a filter to a list, refactor one module.',
    '',
    'L — large:',
    '- Planning must resolve design alternatives, substantial uncertainty, or dependent phases.',
    '- Touches public APIs, data schemas, security/authorization, persistence, deployment, migration, or rollback.',
    '- Requires coordination across subsystems or diagnosis spanning multiple components.',
    '- Examples: migrate authentication to OAuth, make the app multi-tenant, change a public data contract.',
    '',
    'Rules of evidence:',
    '- Do NOT use prompt length. A short prompt can describe a huge task; a long, detailed one can describe a tiny change.',
    '- File or package count is evidence, not a rule: a 50-file mechanical rename can be M; a one-line authorization change can be L.',
    '- Weigh uncertainty and blast radius, not verbosity.',
    '',
    `Task:\n${input.prompt}`,
    input.repositoryContext ? `\nRepository context:\n${input.repositoryContext}` : '',
    '',
    'Respond with ONLY a JSON object as a fenced ```json code block:',
    `{"size": "S" | "M" | "L", "reasonCodes": string[] (subset of: ${SIZE_REASON_CODES.join(', ')})}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) return text.slice(brace, lastBrace + 1);
  return undefined;
}

function parseReasonCodes(block: string | undefined): SizeReasonCode[] {
  if (!block) return [];
  const allowed = new Set<string>(SIZE_REASON_CODES);
  const found = new Set<SizeReasonCode>();
  for (const code of SIZE_REASON_CODES) {
    if (block.includes(code)) found.add(code);
  }
  // (allowed is only used to bound membership above; kept explicit for readers.)
  void allowed;
  return [...found];
}

/**
 * Parses a classifier's textual output into a `SizeClassification`. Returns `undefined` when no size
 * token is present, so the caller treats classification as simply not having happened (the contract's
 * own `size ?? 'M'` default is the single degradation policy — the classifier never invents a size).
 */
export function parseSizingOutput(text: string): SizeClassification | undefined {
  const block = extractJsonBlock(text);
  const candidate = block ?? text;
  const match = candidate.match(/"?size"?\s*[:=]?\s*"?(S|M|L)"?/i) ?? candidate.match(/\b(S|M|L)\b/);
  const raw = match?.[1]?.toUpperCase();
  if (raw !== 'S' && raw !== 'M' && raw !== 'L') return undefined;
  return { size: raw, reasonCodes: parseReasonCodes(candidate) };
}
