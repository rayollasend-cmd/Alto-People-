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
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
