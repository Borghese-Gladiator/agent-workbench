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
  }>;
}

/** The instruction handed to the planner session, telling it exactly what JSON to emit. */
export function plannerInstruction(contract: TaskContract): string {
  return [
    `Produce an implementation plan for this contract objective: ${contract.objective}.`,
    'Decompose the work into ordered slices. Respond with a JSON object of the form',
    '{"summary": string, "slices": [{"objective": string, "likelyPaths": string[],',
    '"requiredTargetedChecks": string[] (non-empty), "claimIds": string[], "dependencies": string[]}]}',
    'as a fenced ```json code block. Each slice must have at least one targeted check.',
  ].join(' ');
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
  const slices: DraftSlice[] = parsed.slices
    .filter((s) => typeof s.objective === 'string' && s.objective.trim().length > 0)
    .map((s) => ({
      objective: s.objective as string,
      claimIds: s.claimIds?.length ? s.claimIds : allClaimIds,
      likelyPaths: s.likelyPaths ?? [],
      requiredTargetedChecks: s.requiredTargetedChecks?.length ? s.requiredTargetedChecks : ['test'],
      dependencies: s.dependencies ?? [],
    }));

  if (slices.length === 0) return undefined;
  return { summary: parsed.summary ?? text.slice(0, 200), slices };
}
