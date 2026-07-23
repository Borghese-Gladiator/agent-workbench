import { describe, expect, it } from 'vitest';
import { derivePrTitle, renderPrBody, renderQaMediaSection } from './pr-content.js';
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
  it('keeps the scope AND action from an "In <scope>, <action>" objective', () => {
    const objective =
      "In the portal header, show the number of available games in the subtitle — e.g. 'Pick a game to play. · 5 games available' — derived from the enabled games in the registry.";
    const title = derivePrTitle(objective, ['portal/src/Portal.jsx']);
    expect(title).not.toContain('[AWB]');
    expect(title).not.toContain('e.g.');
    // Scope preserved as a "Scope: action" prefix, not deleted.
    expect(title).toBe('Portal Header: show the number of available games in the subtitle');
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it('sentence-cases a non-scoped objective', () => {
    expect(derivePrTitle('add a dark-mode toggle to settings')).toBe('Add a dark-mode toggle to settings');
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

describe('renderQaMediaSection', () => {
  const ref = { owner: 'o', repo: 'r' };

  it('links each media kind in a form the reviewer can open in a tab where GitHub allows it', () => {
    const section = renderQaMediaSection({
      ref,
      branch: 'awb/feature',
      qaSummary: 'Browser QA: 2 step(s), 2/2 assertions passed',
      items: [
        { kind: 'screenshot', repoPath: '.awb/qa/screenshot.png' },
        { kind: 'qa-video', repoPath: '.awb/qa/recording.webm' },
        { kind: 'browser-trace', downloadUrl: 'https://example.com/releases/download/x/trace.zip' },
      ],
    });
    // Screenshot: inline image via the raw URL (renders + opens in tab).
    expect(section).toContain('![Browser QA screenshot](https://raw.githubusercontent.com/o/r/awb/feature/.awb/qa/screenshot.png)');
    // Video: GitHub blob-view player (in-tab), NOT a raw/download link.
    expect(section).toContain('(https://github.com/o/r/blob/awb/feature/.awb/qa/recording.webm)');
    expect(section).toContain('opens in a tab');
    // Trace: release-asset download link + how to view it.
    expect(section).toContain('https://example.com/releases/download/x/trace.zip');
    expect(section).toContain('show-trace');
    expect(section).toContain('2/2 assertions passed');
    expect(section).not.toContain('undefined');
  });

  it('returns empty when there is nothing to show', () => {
    expect(renderQaMediaSection({ ref, branch: 'b', items: [] })).toBe('');
  });

  it('omits a kind whose link is missing (no broken markdown)', () => {
    const section = renderQaMediaSection({
      ref,
      branch: 'b',
      items: [{ kind: 'qa-video' }, { kind: 'screenshot', repoPath: '.awb/qa/s.png' }],
    });
    expect(section).toContain('.awb/qa/s.png');
    expect(section).not.toContain('blob/b/undefined');
    expect(section).not.toContain('Recording');
  });
});
