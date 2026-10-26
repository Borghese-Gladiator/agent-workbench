import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { artifactContentUrl, type TaskMediaArtifact, type TaskWorkflowState } from '../../api/tasks.js';

/** Currency of a piece of evidence relative to the current candidate commit. */
type Currency = 'current' | 'stale' | 'unpinned';

/**
 * Verification tab — absorbs the old Evidence Viewer. It organizes what the task has produced into
 * acceptance-oriented groups (Verified candidate evidence, Unverified/Failed open findings) and marks
 * each evidence group current / stale / unpinned by candidate SHA, then renders committed QA media
 * inline. It reads only what the task-state + media routes already expose — there is no per-claim
 * verification route yet, so claims are surfaced as the evidence/findings the run actually recorded
 * rather than a fabricated pass/fail matrix.
 */
export function VerificationTab({
  state,
  media,
  candidateSha,
}: {
  state: TaskWorkflowState;
  media: TaskMediaArtifact[];
  candidateSha: string | null;
}) {
  const currency: Currency = candidateSha ? 'current' : 'unpinned';
  const hasEvidence = state.latestCandidateEvidenceIds.length > 0;
  const hasFindings = state.openFindingIds.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Verified — candidate evidence"
          action={<CurrencyBadge currency={currency} candidateSha={candidateSha} />}
        />
        <PanelBody>
          {!hasEvidence ? (
            <p className="text-sm text-muted-foreground">
              No candidate evidence recorded for this task yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {state.latestCandidateEvidenceIds.map((id) => (
                <li key={id} className="flex items-center gap-2">
                  <Badge variant="done" className="text-[10px]">
                    verified
                  </Badge>
                  <span>{id}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Unverified / Failed — open findings" />
        <PanelBody>
          {!hasFindings ? (
            <p className="text-sm text-muted-foreground">No open findings.</p>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {state.openFindingIds.map((id) => (
                <li key={id} className="flex items-center gap-2">
                  <Badge variant="abandoned" className="text-[10px]">
                    failed
                  </Badge>
                  <span>{id}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {media.length > 0 && (
        <Panel>
          <PanelHeader title="QA media" />
          <PanelBody className="flex flex-col gap-4">
            {media.map((m) => (
              <MediaArtifact key={m.id} artifact={m} />
            ))}
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

function CurrencyBadge({ currency, candidateSha }: { currency: Currency; candidateSha: string | null }) {
  if (currency === 'unpinned') {
    return (
      <Badge variant="outline" className="text-[10px]">
        unpinned
      </Badge>
    );
  }
  return (
    <Badge variant={currency === 'current' ? 'active' : 'approval'} className="text-[10px]">
      {currency} · {candidateSha?.slice(0, 12)}
    </Badge>
  );
}

/** Renders one QA-media artifact inline: GIF/PNG via <img>, WEBM via <video>, trace as a download. */
function MediaArtifact({ artifact }: { artifact: TaskMediaArtifact }) {
  const url = artifactContentUrl(artifact.id);
  if (artifact.mediaType === 'video/webm') {
    return (
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">{artifact.kind}</figcaption>
        <video controls src={url} className="max-w-full rounded-md border" />
      </figure>
    );
  }
  if (artifact.mediaType.startsWith('image/')) {
    return (
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">{artifact.kind}</figcaption>
        <img src={url} alt={artifact.kind} className="max-w-full rounded-md border" />
      </figure>
    );
  }
  return (
    <a href={url} download className="text-sm text-primary underline-offset-4 hover:underline">
      Download {artifact.kind} ({artifact.mediaType})
    </a>
  );
}
