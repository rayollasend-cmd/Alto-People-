import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

// Casing: badges read in sentence case ("Approved", "Out today") per
// docs/design-system.md — uppercase tracking is for eyebrows. `caps` is the
// opt-in for the rare chip that is meant as an eyebrow-style tag.
// A badge is a word or two, never a sentence (G3: a four-problem list in
// a badge became a six-line round blob on a phone). It holds one line —
// `!whitespace-nowrap` beats a parent's `[&_*]:whitespace-normal`, as the
// DataGrid's phone cards have — and never grows past its container; plain
// text that doesn't fit ends in an ellipsis with the whole text as a
// tooltip. Put a list or a sentence beside the badge as text instead.
const badgeVariants = cva(
  'inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-full font-medium !whitespace-nowrap align-middle',
  {
    variants: {
      caps: {
        true: 'uppercase tracking-wider',
        false: '',
      },
      // Status chips draw from the palette's scales (scripts/palette.mjs): a
      // 100 wash, a 200 edge and 800 ink — 4.5:1 or better by construction, on
      // any surface, in both themes, with no alpha over an unknown background.
      variant: {
        // Neutral / informational.
        default: 'bg-navy-secondary text-silver border border-navy-secondary',
        // Successful state — APPROVED, DONE, ACTIVE, VERIFIED.
        success: 'bg-positive-100 text-positive-800 border border-positive-200',
        // In-progress / awaiting — PENDING, IN_REVIEW, DRAFT.
        pending: 'bg-caution-100 text-caution-800 border border-caution-200',
        // Negative — REJECTED, FAILED, CANCELLED.
        destructive: 'bg-negative-100 text-negative-800 border border-negative-200',
        // Premium / featured — gold accent. Also: in-flight/being-worked
        // states (INVESTIGATING, IN_PROGRESS) per the status contract.
        accent: 'bg-accent-100 text-accent-800 border border-accent-200',
        // Informational — steel blue. "Out today", scheduled, info chips.
        info: 'bg-info-100 text-info-800 border border-info-200',
        // Outline-only, used for filter chips.
        outline: 'border border-silver/30 text-silver',
      },
      size: {
        // sm — inline-row chips next to table cell text.
        sm: 'px-1.5 py-0 text-2xs gap-0.5',
        // default — the historical badge size (11px, px-2 py-0.5).
        default: 'px-2 py-0.5 text-xs2 gap-1',
        // lg — page-level status (drawer header, hero KPI). Larger chrome
        // demands a larger dot, which the per-size DOT_SIZE table picks
        // up so the inline indicator doesn't read as a speck against
        // 14px text.
        lg: 'px-2.5 py-1 text-xs gap-1.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      caps: false,
    },
  },
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
  /**
   * Uppercase + letter-spaced label. Off by default — badges read in sentence
   * case. Opt in only for a chip that is deliberately an eyebrow-style tag.
   */
  caps?: boolean;
  /**
   * One line with an ellipsis (the default). `false` lets a long label
   * wrap inside a rounded rectangle instead of a pill — for the rare chip
   * that must show every word; prefer text beside the badge.
   */
  truncate?: boolean;
}

/** Past this a badge is a sentence: say it as text beside the badge. */
export const BADGE_MAX_CHARS = 32;
const warned = new Set<string>();
function warnLong(text: string) {
  if (!import.meta.env.DEV || text.length <= BADGE_MAX_CHARS || warned.has(text)) return;
  warned.add(text);
  console.warn(`Badge: "${text.slice(0, 60)}…" is ${text.length} characters. A badge holds a word or two (≤ ${BADGE_MAX_CHARS}); put the sentence beside it as text.`);
}

const DOT_COLOR: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-silver',
  success: 'bg-positive-700',
  pending: 'bg-caution-700',
  destructive: 'bg-negative-700',
  accent: 'bg-accent-700',
  info: 'bg-info-700',
  outline: 'bg-silver',
};

const DOT_SIZE: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'h-1.5 w-1.5',
  default: 'h-2 w-2',
  lg: 'h-2.5 w-2.5',
};

const DOT_DEFAULT: Record<NonNullable<BadgeProps['variant']>, boolean> = {
  default: false,
  success: true,
  pending: true,
  destructive: true,
  accent: false,
  info: false,
  outline: false,
};

export function Badge({
  className,
  variant,
  size,
  withDot,
  caps,
  truncate = true,
  children,
  title,
  ...props
}: BadgeProps) {
  const v = variant ?? 'default';
  const s = size ?? 'default';
  const showDot = withDot ?? DOT_DEFAULT[v];
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null;
  if (text !== null) warnLong(text);
  return (
    <span
      className={cn(
        badgeVariants({ variant, size, caps }),
        !truncate && '!whitespace-normal rounded-md text-left',
        className,
      )}
      // Plain text gets its whole self as a tooltip, so an ellipsis never hides a word.
      title={title ?? (text !== null && text.length > 12 ? text : undefined)}
      {...props}
    >
      {showDot && (
        <span
          aria-hidden="true"
          className={cn('inline-block rounded-full shrink-0', DOT_SIZE[s], DOT_COLOR[v])}
        />
      )}
      {/* The text node's own span needs the !important too: a parent's `[&_*]` rule reaches it. */}
      {text !== null && truncate ? <span className="min-w-0 truncate !whitespace-nowrap">{text}</span> : children}
    </span>
  );
}

export { badgeVariants };
