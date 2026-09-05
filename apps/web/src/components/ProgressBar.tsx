import { cn } from '@/lib/cn';

interface ProgressBarProps {
  percent: number;
  className?: string;
  hideLabel?: boolean;
  /** Travel duration in ms — pages that choreograph a "progress moment"
   *  (onboarding checklist) pass a longer ride than the 300ms default. */
  travelMs?: number;
}

export function ProgressBar({ percent, className, hideLabel, travelMs = 300 }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={cn('w-full', className)}>
      <div className="h-2 w-full bg-navy-secondary rounded-full overflow-hidden">
        {/* scaleX, not width: width animates LAYOUT (main-thread reflow on
            every frame); scaleX rides the compositor. The track's
            overflow-hidden keeps the rounded ends clean. */}
        <div
          className="h-full w-full origin-left bg-gold transition-transform ease-out"
          style={{ transform: `scaleX(${pct / 100})`, transitionDuration: `${travelMs}ms` }}
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
