import { useState } from 'react';

import { usePageHeader } from '@/components/PageHeader';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Token Usage — a recent-runs table (the primary content). The runs backend
 * (AgentRun) is not built yet, so this renders an intentional skeleton with the
 * real headers + a working session-count dropdown that scopes how many rows
 * will show. Exact metrics are not finalized (see ui-redesign-plan.md), but
 * timestamp / project / model / status / tokens / cost $ are the working set.
 */
const SESSION_COUNTS = [10, 25, 50, 100] as const;

export function Usage() {
  const [sessions, setSessions] = useState<number>(SESSION_COUNTS[0]);

  usePageHeader({ title: 'Token Usage' });

  // No runs backend yet → show a skeleton sized to the chosen session count
  // (capped so a large selection doesn't render dozens of placeholder rows).
  const skeletonRows = Math.min(sessions, 12);

  const sessionControl = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Recent sessions</span>
      <Select value={String(sessions)} onValueChange={(v) => setSessions(Number(v))}>
        <SelectTrigger className="h-8 w-28" aria-label="Recent sessions">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SESSION_COUNTS.map((n) => (
            <SelectItem key={n} value={String(n)}>
              Last {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        Recent agent runs. The runs backend isn’t wired up yet — this is a placeholder showing the
        table shape and the session-count control.
      </p>
      <Panel>
        <PanelHeader title="Recent Runs" action={sessionControl} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost ($)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: skeletonRows }, (_, i) => `skeleton-${i}`).map((key) => (
              <TableRow key={key}>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-28" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-4 w-14" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-4 w-12" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
