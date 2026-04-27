import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider whitespace-nowrap',
  {
    variants: {
      variant: {
        // Neutral / informational.
        default: 'bg-navy-secondary text-silver border border-navy-secondary',
        // Successful state — APPROVED, DONE, ACTIVE, VERIFIED.
        success: 'bg-success/15 text-success border border-success/30',
        // In-progress / awaiting — PENDING, IN_REVIEW, DRAFT.
        pending: 'bg-warning/15 text-warning border border-warning/30',
        // Negative — REJECTED, FAILED, CANCELLED.
        destructive: 'bg-alert/15 text-alert border border-alert/30',
        // Premium / featured — gold accent.
        accent: 'bg-gold/15 text-gold border border-gold/40',
        // Outline-only, used for filter chips.
        outline: 'border border-silver/30 text-silver',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * Phase 67 — Rippling-style status dot. Renders a small filled circle in
   * front of the label, color-matched to the variant.
   *
   * Phase 71 — defaults to TRUE for status variants (success / pending /
   * destructive) so every "APPROVED" / "PENDING" / "REJECTED" chip in the
   * app reads as a real status indicator. Defaults to FALSE for the
   * neutral "default" / "outline" / "accent" variants which are typically
   * filter chips or feature tags. Pass `withDot={false}` to opt out.
   */
  withDot?: boolean;
}

const DOT_COLOR: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-silver',
  success: 'bg-success',
  pending: 'bg-warning',
  destructive: 'bg-alert',
  accent: 'bg-gold',
  outline: 'bg-silver',
};

const DOT_DEFAULT: Record<NonNullable<BadgeProps['variant']>, boolean> = {
  default: false,
  success: true,
  pending: true,
  destructive: true,
  accent: false,
  outline: false,
};

export function Badge({ className, variant, withDot, children, ...props }: BadgeProps) {
  const v = variant ?? 'default';
  const showDot = withDot ?? DOT_DEFAULT[v];
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {showDot && (
        <span
          aria-hidden="true"
          className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', DOT_COLOR[v])}
        />
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
