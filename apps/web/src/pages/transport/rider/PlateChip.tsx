import { cn } from '@/lib/cn';

/**
 * A van's plate, drawn like a plate — what a rider matches at the curb.
 * White with dark letters in both themes (a real plate doesn't flip).
 */
export function PlateChip({ plate, size = 'md', className }: { plate: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border-2 border-on-accent/80 bg-white font-mono font-bold uppercase tracking-widest text-on-accent tabular-nums',
        size === 'sm' && 'px-1.5 py-0.5 text-xs2',
        size === 'md' && 'px-2.5 py-1 text-sm',
        size === 'lg' && 'px-3.5 py-1.5 text-xl',
        className,
      )}
    >
      {plate}
    </span>
  );
}
