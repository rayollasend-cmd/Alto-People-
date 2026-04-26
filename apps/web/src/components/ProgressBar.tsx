import { cn } from '@/lib/cn';

interface ProgressBarProps {
  percent: number;
  className?: string;
  hideLabel?: boolean;
}

export function ProgressBar({ percent, className, hideLabel }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={cn('w-full', className)}>
      <div className="h-2 w-full bg-navy-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-gold transition-all duration-300"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {!hideLabel && (
        <div className="text-xs text-silver mt-1">{pct}% complete</div>
      )}
    </div>
  );
}
