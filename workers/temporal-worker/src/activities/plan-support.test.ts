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

  it('plannerInstruction names the objective and asks for JSON slices', () => {
    const instruction = plannerInstruction(contract);
    expect(instruction).toContain('President');
    expect(instruction).toContain('json');
  });
});
