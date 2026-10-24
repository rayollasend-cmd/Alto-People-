import { cn } from '@/lib/cn';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * A page on its way: shown while the role's home chunk loads (Dashboard)
 * and, in the same place, while its first data lands (FirstLoadGate), so
 * the two waits read as one — the placeholder never jumps between them. Its
 * own module so the entry chunk (Dashboard) can use it without pulling the
 * templates in.
 */
export function HomeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-4', className)} aria-label="Loading">
      <Skeleton className="h-8 w-1/3" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24 hidden lg:block" />
        <Skeleton className="h-24 hidden lg:block" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
