import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Inline error banner for "we tried to load/save and it failed" states.
 *
 * The canonical shape is `border-alert/40 bg-alert/10 text-alert text-sm` —
 * 44+ pages already inline that recipe; this just promotes it so a few
 * outliers (Settings using raw red-300, Kiosk using bare red-400, several
 * pages wrapping the error in a CardContent and doubling the padding)
 * can converge on the same look.
 *
 * For the full-page "this thing failed entirely" state (where the error
 * replaces page content rather than sitting above it), wrap this in a
 * Card. For the inline "this field is wrong" state, prefer Label + the
 * Input's invalid prop — this primitive is for whole-section failures.
 */
interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The message to display. Strings/JSX both fine. */
  children: React.ReactNode;
  /** Hide the leading alert icon. Defaults to showing it. */
  hideIcon?: boolean;
}

export function ErrorBanner({
  children,
  hideIcon,
  className,
  ...rest
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert',
        className,
      )}
      {...rest}
    >
      {!hideIcon && (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
