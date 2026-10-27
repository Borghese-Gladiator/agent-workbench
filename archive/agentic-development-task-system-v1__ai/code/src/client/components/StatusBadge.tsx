import { Badge } from '@client/components/ui/badge';
import { cn } from '@client/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  // Work item statuses
  triage: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  ready: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  in_progress: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  in_review: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  done: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  canceled: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  // Epic statuses
  open: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  // Initiative statuses
  active: 'bg-green-500/10 text-green-500 border-green-500/20',
  completed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  // Review outcomes
  approved: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  changes_requested: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  // Work item kinds
  task: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  bug: 'bg-red-500/10 text-red-500 border-red-500/20',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const colors = STATUS_COLORS[status] ?? 'bg-gray-500/10 text-gray-500 border-gray-500/20';
  return (
    <Badge variant="outline" className={cn(colors, className)}>
      {(status ?? '').replace(/_/g, ' ')}
    </Badge>
  );
}
