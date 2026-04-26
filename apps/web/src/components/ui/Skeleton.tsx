import { cn } from '@/lib/cn';

/**
 * Loading placeholder. Use to mirror the *shape* of the data that's
 * about to render — a row of text → a Skeleton with the right width;
 * a table → a stack of Skeleton rows. Avoid blanket "Loading…" text.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-navy-secondary/60',
        // Subtle shimmer sweep — runs forever; cheap because it's transform-only.
        'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer',
        'before:bg-gradient-to-r before:from-transparent before:via-white/5 before:to-transparent',
        className
      )}
      aria-busy="true"
      aria-live="polite"
      {...props}
    />
  );
}

/** Convenience: a stack of identical-height skeleton rows. */
export function SkeletonRows({
  count = 3,
  rowHeight = 'h-12',
  className,
}: {
  count?: number;
  rowHeight?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={rowHeight} />
      ))}
    </div>
  );
}
