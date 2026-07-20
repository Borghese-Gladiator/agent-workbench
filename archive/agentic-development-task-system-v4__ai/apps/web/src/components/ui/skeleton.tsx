import { cn } from '@/lib/utils';

/** A pulsing placeholder block, for intentional loading/empty states. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
