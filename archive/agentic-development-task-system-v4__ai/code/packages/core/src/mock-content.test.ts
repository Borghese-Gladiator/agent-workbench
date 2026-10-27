import { describe, expect, it } from 'vitest';
import { mockArtifactBody } from './mock-content.js';

describe('mockArtifactBody — task_brief', () => {
  const base = { taskTitle: 'T', rawRequest: 'do a thing' };

  it('omits the revision section with no feedback', () => {
    const body = mockArtifactBody('task_brief', base);
    expect(body).not.toContain('Revision feedback addressed');
  });

  it('incorporates rejection feedback into the regenerated brief', () => {
    const body = mockArtifactBody('task_brief', {
      ...base,
      rejectionFeedback: 'make it more concise',
    });
    expect(body).toContain('Revision feedback addressed');
    expect(body).toContain('make it more concise');
    // The regenerated brief differs from the first-pass body.
    expect(body).not.toBe(mockArtifactBody('task_brief', base));
  });

  it('ignores blank feedback', () => {
    const body = mockArtifactBody('task_brief', { ...base, rejectionFeedback: '   ' });
    expect(body).toBe(mockArtifactBody('task_brief', base));
  });

  it('renders the Acceptance Criteria table with stable IDs + open-assumptions diff', () => {
    const body = mockArtifactBody('task_brief', base);
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('| ID | Requirement | Risk (H/M/L) |');
    expect(body).toContain('| AC1 |');
    expect(body).toContain('## Open assumptions / interpretation decisions');
  });
});

describe('mockArtifactBody — acceptance-criteria contract', () => {
  const base = { taskTitle: 'T', rawRequest: 'do a thing' };

  it('execution_plan binds each criterion ID to a validation method', () => {
    const body = mockArtifactBody('execution_plan', base);
    expect(body).toContain('## Validation by criterion');
    expect(body).toContain('| Criterion ID | Validation method | Test type | Automated? |');
    expect(body).toContain('| AC1 |');
  });

  it('validation_report gates per scenario + maps criteria to proving scenarios', () => {
    const body = mockArtifactBody('validation_report', base);
    expect(body).toContain('## Would this have failed before this change?');
    expect(body).toContain('## Criterion coverage');
    expect(body).toContain('| Criterion ID | Proving scenario |');
  });
});

describe('mockArtifactBody — feedback-carrying kinds', () => {
  const base = { taskTitle: 'T', rawRequest: 'do a thing' };

  it('execution_plan incorporates rejection feedback', () => {
    const body = mockArtifactBody('execution_plan', {
      ...base,
      rejectionFeedback: 'add a rollback step',
    });
    expect(body).toContain('Revision feedback addressed');
    expect(body).toContain('add a rollback step');
    expect(body).not.toBe(mockArtifactBody('execution_plan', base));
  });

  it('bounce_packet renders the real feedback under Why bounced', () => {
    const withFeedback = mockArtifactBody('bounce_packet', {
      ...base,
      rejectionFeedback: 'tests are missing',
    });
    expect(withFeedback).toContain('tests are missing');
    expect(withFeedback).not.toContain('Reviewer feedback summarized here');

    // Falls back to the mock line when no feedback is provided.
    expect(mockArtifactBody('bounce_packet', base)).toContain('Reviewer feedback summarized here');
  });
});
