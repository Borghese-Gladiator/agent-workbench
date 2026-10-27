import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskMediaArtifact, TaskWorkflowState } from '../../api/tasks.js';
import { VerificationTab } from './VerificationTab.js';

function state(overrides: Partial<TaskWorkflowState> = {}): TaskWorkflowState {
  return {
    taskId: 'task-1',
    repositoryId: 'repo-1',
    phase: 'qa',
    condition: 'running',
    deliveryState: 'none',
    attemptNumber: 1,
    latestCandidateEvidenceIds: [],
    openFindingIds: [],
    tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
    runtimeMsByPhase: {},
    ...overrides,
  };
}

describe('VerificationTab', () => {
  it('groups candidate evidence as verified and open findings as failed', () => {
    render(
      <VerificationTab
        state={state({ latestCandidateEvidenceIds: ['ev-1'], openFindingIds: ['find-1'] })}
        media={[]}
        candidateSha="abc123def456"
      />,
    );
    expect(screen.getByText('verified')).toBeInTheDocument();
    expect(screen.getByText('ev-1')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('find-1')).toBeInTheDocument();
  });

  it('marks evidence current with the candidate sha, or unpinned when absent', () => {
    const { rerender } = render(
      <VerificationTab state={state()} media={[]} candidateSha="abc123def456ff" />,
    );
    expect(screen.getByText(/current · abc123def456/)).toBeInTheDocument();

    rerender(<VerificationTab state={state()} media={[]} candidateSha={null} />);
    expect(screen.getByText('unpinned')).toBeInTheDocument();
  });

  it('absorbs QA media, rendering a video artifact inline', () => {
    const media: TaskMediaArtifact[] = [
      { id: 'art-1', kind: 'qa-video', mediaType: 'video/webm', byteSize: 1000 },
    ];
    const { container } = render(
      <VerificationTab state={state()} media={media} candidateSha={null} />,
    );
    expect(screen.getByText('QA media')).toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeNull();
  });
});
