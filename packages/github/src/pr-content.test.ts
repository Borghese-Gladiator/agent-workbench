import { describe, expect, it } from 'vitest';
import { derivePrTitle, renderPrBody, renderQaMediaBrief } from './pr-content.js';
import type { Evidence } from '@awb/domain';

function ev(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'e', taskId: 't', runId: 'r', phaseAttemptId: 'p',
    kind: 'unit-test', status: 'passed', claimIds: ['c1'],
    contractVersion: 1, repositorySnapshotId: 's', candidateSha: 'a'.repeat(40),
    policyVersion: 'v1', artifactIds: [], summary: 'npm run test exited 0 (passed)',
    createdAt: '2026-07-22T00:00:00Z', ...overrides,
  };
}

describe('derivePrTitle', () => {
  it('shortens the long objective and drops the "In <file>," preamble', () => {
    const objective =
      "In the portal header, show the number of available games in the subtitle — e.g. 'Pick a game to play. · 5 games available' — derived from the enabled games in the registry.";
    const title = derivePrTitle(objective, ['portal/src/Portal.jsx']);
    expect(title).not.toContain('[AWB]');
    expect(title).not.toContain('e.g.');
    expect(title).not.toMatch(/^In /);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.toLowerCase()).toContain('number of available games');
  });

  it('caps very long single-clause objectives with an ellipsis', () => {
    const long = 'Refactor ' + 'the extremely important subsystem '.repeat(6);
    expect(derivePrTitle(long).length).toBeLessThanOrEqual(72);
    expect(derivePrTitle(long).endsWith('…')).toBe(true);
  });

  it('falls back to a change-area label when the objective is empty', () => {
    expect(derivePrTitle('', ['portal/src/Portal.jsx'])).toBe('Update portal/src');
  });
});

describe('renderPrBody', () => {
  it('renders Background, Changes (with files), and Test plan from evidence', () => {
    const body = renderPrBody({
      objective: 'Show N games available',
      planSummary: 'Compute enabled count and render it in the subtitle.',
      changedPaths: ['portal/src/Portal.jsx', 'portal/src/Portal.test.jsx'],
      evidence: [ev(), ev({ kind: 'qa-video', summary: 'Browser QA: 2 step(s), 2/2 assertions passed' })],
      candidateSha: 'a'.repeat(40),
    });
    expect(body).toContain('## Background');
    expect(body).toContain('Show N games available');
    expect(body).toContain('## Changes');
    expect(body).toContain('Compute enabled count');
    expect(body).toContain('`portal/src/Portal.jsx`');
    expect(body).toContain('## Test plan');
    expect(body).toContain('✅ **unit-test**');
    expect(body).toContain('✅ **qa-video**');
    expect(body).toContain('aaaaaaaaaaaa'); // short candidate sha
  });

  it('marks a failed evidence row with a fail icon', () => {
    const body = renderPrBody({
      objective: 'x', changedPaths: [], candidateSha: 'a'.repeat(40),
      evidence: [ev({ status: 'failed', summary: 'boom' })],
    });
    expect(body).toContain('❌ **unit-test** — boom');
  });
});

describe('renderQaMediaBrief', () => {
  it('describes what was tested and links the recording when a URL is present', () => {
    const brief = renderQaMediaBrief({
      kind: 'qa-video',
      qaSummary: 'Browser QA: 2 step(s), 2/2 assertions passed',
      mediaUrl: 'https://example.com/releases/download/x/qa.webm',
    });
    expect(brief).toContain('Browser QA recording');
    expect(brief).toContain('2/2 assertions passed');
    expect(brief).toContain('](https://example.com/releases/download/x/qa.webm)');
    expect(brief).not.toContain('undefined');
    expect(brief).not.toContain('QA artifact');
  });

  it('omits the link when no URL is available (never prints undefined)', () => {
    const brief = renderQaMediaBrief({ kind: 'qa-video', qaSummary: 'exercised the change' });
    expect(brief).not.toContain('undefined');
    expect(brief).not.toContain('](');
  });
});
