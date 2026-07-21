import { describe, expect, it } from 'vitest';
import type { TaskContract } from '@awb/domain';
import { parsePlannerOutput, plannerInstruction } from './plan-support.js';

const contract = {
  id: 'c1',
  taskId: 't1',
  version: 1,
  objective: 'Build the President card game',
  constraints: [],
  nonGoals: [],
  claims: [
    { id: 'claim-1', description: 'engine works', category: 'correctness', deterministicEvidenceRequired: true, qaEvidenceRequired: false, humanJudgmentRequired: false },
    { id: 'claim-2', description: 'ui works', category: 'correctness', deterministicEvidenceRequired: false, qaEvidenceRequired: true, humanJudgmentRequired: false },
  ],
  status: 'draft',
} as unknown as TaskContract;

describe('parsePlannerOutput', () => {
  it('parses a fenced JSON plan into real multi-slice output', () => {
    const text = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        summary: 'engine then client',
        slices: [
          { objective: 'implement engine', likelyPaths: ['packages/engines/president/src/engine.js'], requiredTargetedChecks: ['vitest run engine'], claimIds: ['claim-1'], dependencies: [] },
          { objective: 'implement client', likelyPaths: ['games/president/'], requiredTargetedChecks: ['playwright test'], claimIds: ['claim-2'], dependencies: ['implement engine'] },
        ],
      }),
      '```',
    ].join('\n');

    const parsed = parsePlannerOutput(text, contract);
    if (!parsed) throw new Error('expected a parsed plan');
    expect(parsed.slices).toHaveLength(2);
    const [engineSlice, clientSlice] = parsed.slices;
    if (!engineSlice || !clientSlice) throw new Error('expected two slices');
    expect(engineSlice.objective).toBe('implement engine');
    expect(clientSlice.requiredTargetedChecks).toEqual(['playwright test']);
  });

  it('defaults claimIds to all contract claims and checks to a non-empty fallback', () => {
    const text = '```json\n' + JSON.stringify({ slices: [{ objective: 'do it' }] }) + '\n```';
    const parsed = parsePlannerOutput(text, contract);
    const first = parsed?.slices[0];
    if (!first) throw new Error('expected a parsed slice');
    expect(first.claimIds).toEqual(['claim-1', 'claim-2']);
    expect(first.requiredTargetedChecks.length).toBeGreaterThan(0);
  });

  it('returns undefined when there is no JSON block (caller falls back)', () => {
    expect(parsePlannerOutput('just prose, no json', contract)).toBeUndefined();
  });

  it('returns undefined on malformed JSON or empty slices', () => {
    expect(parsePlannerOutput('```json\n{ not valid\n```', contract)).toBeUndefined();
    expect(parsePlannerOutput('```json\n{"slices":[]}\n```', contract)).toBeUndefined();
  });

  it('parses declared qaScenarioIds from a slice', () => {
    const text =
      '```json\n' +
      JSON.stringify({
        slices: [{ objective: 'do it', claimIds: ['claim-1'], qaScenarioIds: ['scenario-a'] }],
      }) +
      '\n```';
    const parsed = parsePlannerOutput(text, contract);
    expect(parsed?.slices[0]?.qaScenarioIds).toEqual(['scenario-a']);
  });

  // A behavioral + qaEvidenceRequired claim whose covering slice omits qaScenarioIds must get a
  // synthesized scenario, or the plan gate stalls the task (TASK-1 root cause).
  it('synthesizes a qa scenario for a covered behavioral claim when the planner omits one', () => {
    const behavioralContract = {
      ...contract,
      claims: [
        { id: 'b1', description: 'behaves', category: 'behavior', deterministicEvidenceRequired: false, qaEvidenceRequired: true, humanJudgmentRequired: false },
      ],
    } as unknown as TaskContract;
    const text = '```json\n' + JSON.stringify({ slices: [{ objective: 'Play a round', claimIds: ['b1'] }] }) + '\n```';
    const parsed = parsePlannerOutput(text, behavioralContract);
    expect(parsed?.slices[0]?.qaScenarioIds?.length).toBeGreaterThan(0);
  });

  // A live planner mapped only the behavioral claim and dropped the correctness one, which failed
  // everyClaimMappedToSlice and blocked the plan. Unmapped claims must attach to the first slice.
  it('attaches contract claims the planner left unmapped to the first slice', () => {
    const text =
      '```json\n' +
      JSON.stringify({
        slices: [{ objective: 'Add the section', claimIds: ['claim-2'], requiredTargetedChecks: ['docs check'] }],
      }) +
      '\n```';
    const parsed = parsePlannerOutput(text, contract);
    const covered = new Set((parsed?.slices ?? []).flatMap((s) => s.claimIds));
    expect(covered.has('claim-1')).toBe(true);
    expect(covered.has('claim-2')).toBe(true);
  });

  it('plannerInstruction names the objective and asks for JSON slices', () => {
    const instruction = plannerInstruction(contract);
    expect(instruction).toContain('President');
    expect(instruction).toContain('json');
  });

  it('plannerInstruction biases toward the fewest slices (TASK-19)', () => {
    const instruction = plannerInstruction(contract);
    expect(instruction).toMatch(/FEW slices|SINGLE slice/);
    expect(instruction).toMatch(/investigate|discover|verify/i);
  });

  it('plannerInstruction demands qaScenarioIds when a behavioral qa claim exists', () => {
    const behavioralContract = {
      ...contract,
      claims: [
        { id: 'b1', description: 'behaves', category: 'behavior', deterministicEvidenceRequired: false, qaEvidenceRequired: true, humanJudgmentRequired: false },
      ],
    } as unknown as TaskContract;
    expect(plannerInstruction(behavioralContract)).toContain('qaScenarioIds');
    expect(plannerInstruction(behavioralContract)).toContain('b1');
  });
});
