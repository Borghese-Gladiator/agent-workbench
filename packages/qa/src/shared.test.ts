import { describe, expect, it } from 'vitest';
import { deriveQaStatus, produceQaEvidence } from './shared.js';
import { makeQaEvidenceContext } from './test-helpers.js';

describe('deriveQaStatus', () => {
  it('passes when all assertions pass and the required artifact exists', () => {
    expect(deriveQaStatus([{ name: 'a', passed: true }], true, false)).toBe('passed');
  });

  it('fails when any assertion fails, even if the artifact exists', () => {
    expect(
      deriveQaStatus([{ name: 'a', passed: true }, { name: 'b', passed: false }], true, false),
    ).toBe('failed');
  });

  it('is inconclusive when execution errored, regardless of assertions', () => {
    expect(deriveQaStatus([{ name: 'a', passed: true }], true, true)).toBe('inconclusive');
  });

  it('is inconclusive when the required artifact was not produced, even if assertions passed', () => {
    expect(deriveQaStatus([{ name: 'a', passed: true }], false, false)).toBe('inconclusive');
  });

  it('never passes on artifact presence alone with no assertions run and an error', () => {
    expect(deriveQaStatus([], true, true)).toBe('inconclusive');
  });

  it('treats execution error as inconclusive even when a failed assertion is also present', () => {
    expect(
      deriveQaStatus([{ name: 'execution', passed: false }], true, true),
    ).toBe('inconclusive');
  });
});

describe('produceQaEvidence', () => {
  it('builds an Evidence record whose status matches deriveQaStatus and carries artifact ids', () => {
    const context = makeQaEvidenceContext();
    const evidence = produceQaEvidence({
      kind: 'qa-video',
      assertions: [{ name: 'ok', passed: true }],
      requiredArtifactProduced: true,
      executionErrored: false,
      artifactIds: ['artifact-1'],
      summary: 'test summary',
      context,
    });

    expect(evidence.status).toBe('passed');
    expect(evidence.artifactIds).toEqual(['artifact-1']);
    expect(evidence.taskId).toBe(context.taskId);
    expect(evidence.kind).toBe('qa-video');
    expect(evidence.summary).toBe('test summary');
  });
});
