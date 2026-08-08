import type { PlanSlice, TaskContract } from '@awb/domain';

type DraftSlice = Omit<PlanSlice, 'id'>;

/** The planner is asked to emit its plan as a JSON block in this shape. */
interface PlannerPlanJson {
  summary?: string;
  slices?: Array<{
    objective?: string;
    claimIds?: string[];
    likelyPaths?: string[];
    requiredTargetedChecks?: string[];
    dependencies?: string[];
    qaScenarioIds?: string[];
  }>;
}

/** The instruction handed to the planner session, telling it exactly what JSON to emit. */
export function plannerInstruction(contract: TaskContract, hasMemory = false): string {
  // When project memory was injected into the context payload (read side of TASK-50), point the
  // planner at it so accumulated pitfalls/conventions/commands actually inform the plan.
  const memoryLine = hasMemory
    ? 'The context includes a "memory" array of facts prior runs learned about this repository ' +
      '(pitfalls, invariants, conventions, build/test commands). Use it: avoid known pitfalls, respect ' +
      'invariants/conventions, and prefer the recorded commands over guessing.'
    : '';
  const behavioralClaimIds = contract.claims
    .filter((c) => c.category === 'behavior' && c.qaEvidenceRequired)
    .map((c) => c.id);
  const qaLine =
    behavioralClaimIds.length > 0
      ? [
          `The contract has behavioral claim(s) requiring QA evidence: ${behavioralClaimIds.join(', ')}.`,
          'At least one slice that lists such a claim in its "claimIds" MUST also declare a non-empty',
          '"qaScenarioIds" naming the QA scenario(s) that exercise it, or the plan will be rejected.',
        ].join(' ')
      : '';
  return [
    `Produce an implementation plan for this contract objective: ${contract.objective}.`,
    'Decompose the work into ordered slices. Respond with a JSON object of the form',
    '{"summary": string, "slices": [{"objective": string, "likelyPaths": string[],',
    '"requiredTargetedChecks": string[] (non-empty), "claimIds": string[], "dependencies": string[],',
    '"qaScenarioIds": string[]}]}',
    'as a fenced ```json code block. Each slice must have at least one targeted check.',
    // Bias toward the smallest plan that covers the work (TASK-19): each slice is executed as a
    // separate, cold builder session, so extra slices multiply runtime and token cost. Investigation
    // is not its own slice — fold discovery and verification into the slice that makes the change.
    'IMPORTANT: use as FEW slices as possible — prefer a SINGLE slice unless the work spans genuinely',
    'independent units (e.g. separate packages/files that can be built and checked on their own).',
    'Do NOT create separate "investigate/discover" or "verify/validate" slices: exploring the repo',
    'and running the checks are part of implementing the change, so put them in the same slice.',
    memoryLine,
    qaLine,
  ]
    .filter(Boolean)
    .join(' ');
}

function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) return text.slice(brace, lastBrace + 1);
  return undefined;
}

/**
 * Parses a planner session's textual output into plan slices. Returns undefined when nothing
 * usable is present, so the caller can fall back. Every returned slice is guaranteed a non-empty
 * `requiredTargetedChecks` (the `everySliceHasTargetedChecks` gate), and claimIds default to all
 * contract claims when the planner omitted them.
 */
export function parsePlannerOutput(
  text: string,
  contract: TaskContract,
): { summary: string; slices: DraftSlice[] } | undefined {
  const block = extractJsonBlock(text);
  if (!block) return undefined;

  let parsed: PlannerPlanJson;
  try {
    parsed = JSON.parse(block) as PlannerPlanJson;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.slices) || parsed.slices.length === 0) return undefined;

  const allClaimIds = contract.claims.map((c) => c.id);
  const behavioralClaimIds = new Set(
    contract.claims.filter((c) => c.category === 'behavior' && c.qaEvidenceRequired).map((c) => c.id),
  );
  const slices: DraftSlice[] = parsed.slices
    .filter((s) => typeof s.objective === 'string' && s.objective.trim().length > 0)
    .map((s) => {
      const claimIds = s.claimIds?.length ? s.claimIds : allClaimIds;
      // Forgiving fallback: if this slice covers a behavioral+QA-required claim but the planner
      // forgot to name a scenario, synthesize one from the slice objective. Without this the plan
      // gate (everyBehavioralClaimHasQaScenario) would reject an otherwise-fine plan and stall the
      // whole task at plan with `repeated-failure-no-progress`.
      const coversBehavioral = claimIds.some((id) => behavioralClaimIds.has(id));
      let qaScenarioIds = s.qaScenarioIds?.length ? s.qaScenarioIds : [];
      if (coversBehavioral && qaScenarioIds.length === 0) {
        qaScenarioIds = [`qa-${slugify(s.objective as string)}`];
      }
      return {
        objective: s.objective as string,
        claimIds,
        likelyPaths: s.likelyPaths ?? [],
        requiredTargetedChecks: s.requiredTargetedChecks?.length ? s.requiredTargetedChecks : ['test'],
        dependencies: s.dependencies ?? [],
        qaScenarioIds,
      };
    });

  if (slices.length === 0) return undefined;

  // Forgiving coverage completion: every contract claim must map to at least one slice, or the plan
  // gate (everyClaimMappedToSlice) blocks the task. When the planner under-specifies `claimIds`
  // (e.g. maps only the behavioral claim and drops the correctness one), assign each unmapped claim
  // to the first slice rather than reject an otherwise-sound plan.
  const coveredClaimIds = new Set(slices.flatMap((s) => s.claimIds));
  const unmapped = allClaimIds.filter((id) => !coveredClaimIds.has(id));
  if (unmapped.length > 0 && slices[0]) {
    slices[0].claimIds = [...new Set([...slices[0].claimIds, ...unmapped])];
    // A newly-attached behavioral+QA claim needs a scenario on that slice too.
    if (unmapped.some((id) => behavioralClaimIds.has(id)) && (slices[0].qaScenarioIds?.length ?? 0) === 0) {
      slices[0].qaScenarioIds = [`qa-${slugify(slices[0].objective)}`];
    }
  }

  return { summary: parsed.summary ?? text.slice(0, 200), slices };
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'scenario'
  );
}
