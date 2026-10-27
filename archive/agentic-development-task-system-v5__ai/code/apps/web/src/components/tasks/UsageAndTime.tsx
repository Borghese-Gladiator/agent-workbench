import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { formatDuration, formatTokens } from '@/lib/format';
import type {
  ExecutionTreeResponse,
  RuntimeAttributionRow,
  TokenBreakdown,
} from '../../api/tasks.js';

/** The 12 runtime-attribution buckets, in a stable display order with human labels. */
const RUNTIME_BUCKETS: { key: keyof Omit<RuntimeAttributionRow, 'phase'>; label: string }[] = [
  { key: 'modelWaitMs', label: 'Model wait' },
  { key: 'modelGenerationMs', label: 'Model generation' },
  { key: 'toolExecutionMs', label: 'Tool execution' },
  { key: 'testExecutionMs', label: 'Test execution' },
  { key: 'qaExecutionMs', label: 'QA execution' },
  { key: 'environmentSetupMs', label: 'Environment setup' },
  { key: 'dependencyInstallMs', label: 'Dependency install' },
  { key: 'serviceStartupMs', label: 'Service startup' },
  { key: 'artifactProcessingMs', label: 'Artifact processing' },
  { key: 'githubOperationMs', label: 'GitHub operation' },
  { key: 'humanWaitMs', label: 'Human wait' },
  { key: 'retryBackoffMs', label: 'Retry backoff' },
];

/**
 * Usage & Time: the task → phase → attempt → session → invocation token hierarchy (rolled from the
 * execution tree), the runtime-attribution buckets summed across attempts, and a rework metric — the
 * share of tokens spent on retried phase attempts (attemptNumber > 1). Everything is durable.
 */
export function UsageAndTime({
  tree,
  tokenBreakdown,
  runtimeAttribution,
}: {
  tree: ExecutionTreeResponse;
  tokenBreakdown?: TokenBreakdown;
  runtimeAttribution?: RuntimeAttributionRow[];
}) {
  const rework = computeReworkTokens(tree);
  const totalTokens = rework.totalInput + rework.totalOutput;
  const reworkPct = totalTokens > 0 ? Math.round((rework.reworkTokens / totalTokens) * 100) : 0;

  const runtimeTotals = sumRuntimeBuckets(runtimeAttribution ?? []);
  const totalRuntimeMs = RUNTIME_BUCKETS.reduce((acc, b) => acc + runtimeTotals[b.key], 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Input tokens" value={formatTokens(rework.totalInput)} />
        <StatTile label="Output tokens" value={formatTokens(rework.totalOutput)} />
        <StatTile
          label="Cost"
          value={tokenBreakdown?.totals.costUsd != null ? `$${tokenBreakdown.totals.costUsd.toFixed(2)}` : '—'}
        />
        <StatTile
          label="Rework"
          value={`${reworkPct}%`}
          tone={reworkPct >= 40 ? 'danger' : reworkPct >= 20 ? 'warn' : 'default'}
        />
      </div>

      <Panel>
        <PanelHeader title="Tokens by phase attempt" />
        <PanelBody>
          {tree.phaseAttempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {tree.phaseAttempts.map((attempt) => {
                const t = attemptTokens(attempt);
                return (
                  <li key={attempt.id} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      <span className="capitalize text-foreground">{attempt.phase}</span> · attempt{' '}
                      {attempt.attemptNumber}
                      {attempt.attemptNumber > 1 && (
                        <span className="ml-1 text-warn">(rework)</span>
                      )}
                    </span>
                    <span className="font-mono tabular-nums text-foreground">
                      {formatTokens(t.input)} / {formatTokens(t.output)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {tokenBreakdown && Object.keys(tokenBreakdown.byModel).length > 0 && (
        <Panel>
          <PanelHeader title="Tokens by model" />
          <PanelBody>
            <ul className="flex flex-col gap-1.5 text-sm">
              {Object.entries(tokenBreakdown.byModel).map(([model, t]) => (
                <li key={model} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{model}</span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatTokens(t.inputTokens)} / {formatTokens(t.outputTokens)}
                  </span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Runtime attribution" />
        <PanelBody>
          {totalRuntimeMs === 0 ? (
            <p className="text-sm text-muted-foreground">No runtime attribution recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {RUNTIME_BUCKETS.filter((b) => runtimeTotals[b.key] > 0).map((b) => (
                <li key={b.key} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatDuration(runtimeTotals[b.key])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function attemptTokens(attempt: ExecutionTreeResponse['phaseAttempts'][number]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const session of attempt.sessions) {
    for (const inv of session.invocations) {
      input += inv.inputTokens;
      output += inv.outputTokens;
    }
  }
  return { input, output };
}

function computeReworkTokens(tree: ExecutionTreeResponse): {
  totalInput: number;
  totalOutput: number;
  reworkTokens: number;
} {
  let totalInput = 0;
  let totalOutput = 0;
  let reworkTokens = 0;
  for (const attempt of tree.phaseAttempts) {
    const t = attemptTokens(attempt);
    totalInput += t.input;
    totalOutput += t.output;
    if (attempt.attemptNumber > 1) reworkTokens += t.input + t.output;
  }
  return { totalInput, totalOutput, reworkTokens };
}

function sumRuntimeBuckets(
  rows: RuntimeAttributionRow[],
): Record<keyof Omit<RuntimeAttributionRow, 'phase'>, number> {
  const totals = {} as Record<keyof Omit<RuntimeAttributionRow, 'phase'>, number>;
  for (const b of RUNTIME_BUCKETS) totals[b.key] = 0;
  for (const row of rows) {
    for (const b of RUNTIME_BUCKETS) totals[b.key] += row[b.key] ?? 0;
  }
  return totals;
}
