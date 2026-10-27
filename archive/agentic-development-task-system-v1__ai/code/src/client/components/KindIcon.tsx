import { CheckSquare, Bug } from 'lucide-react';
import { cn } from '@client/lib/utils';

const KIND_CONFIG: Record<string, { icon: typeof CheckSquare; color: string }> = {
  task: { icon: CheckSquare, color: 'text-gray-400' },
  bug: { icon: Bug, color: 'text-red-500' },
};

export function KindIcon({ kind, size = 16, className }: { kind: string; size?: number; className?: string }) {
  const config = KIND_CONFIG[kind] ?? KIND_CONFIG.task;
  const Icon = config.icon;
  return <Icon className={cn(config.color, className)} size={size} />;
}
