import * as React from 'react';
import { cn } from '@/lib/cn';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Render the card with hover-lift styling so callers don't have to
   * remember to bolt on `transition hover:border-steel hover:bg-...`
   * every time they put a Link or button around a card. Use this for
   * any card whose entire surface is a click target (KPI tiles, list
   * cards). Defaults to false to keep the static look for content
   * cards.
   */
  interactive?: boolean;
  /**
   * Opt out of the entrance animation. Cards ease in by default — a 0.18s
   * fade and 4px rise as they mount, which is what makes content arrive
   * rather than blink into place.
   *
   * It used to be opt-in via `animate-enter`, and only the associate-facing
   * pages opted in: an associate got staged entrances while a manager on
   * the same build got hard cuts. Defaulting it on evens that out, since
   * React keeps mounted rows across re-renders — only genuinely new content
   * animates, not every refetch.
   *
   * Pass `animate={false}` where a card is already inside something that
   * animates (so the two don't compound), or for a card that mounts on a
   * fast timer.
   */
  animate?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive, animate = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-navy-secondary bg-navy text-white elev-1',
        animate && 'animate-enter',
        interactive &&
          'transition-colors hover:border-steel hover:bg-navy-secondary/30 hover:elev-2 focus-within:border-steel cursor-pointer',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col space-y-1.5 p-5 pb-3', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  // h2, not h3: card titles sit directly under the page's h1 in practice
  // (same reasoning as EmptyState) — an h1 → h3 jump trips axe's
  // heading-order rule. Styling is class-driven, so this is visual-noop.
  // eslint-disable-next-line jsx-a11y/heading-has-content -- children arrive via {...props}; every call site passes text.
  <h2
    ref={ref}
    className={cn('text-xl text-white leading-tight', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-silver', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-5 pt-3', className)} {...props} />
));
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex items-center justify-between gap-2 p-5 pt-0', className)}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';
