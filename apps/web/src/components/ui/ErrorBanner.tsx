import * as React from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Inline banner for "we tried to load/save and it failed" and related
 * states. Three severity tiers map to the existing palette tokens:
 *
 *   - `error`   (default) — alert red, used for genuine failures
 *   - `warning` — gold/warning yellow, used for recoverable issues
 *   - `info`    — silver/steel, used for advisory messages
 *
 * The bumped alpha (border /60, bg /15) lifts the previous whisper-quiet
 * treatment to mid-weight so genuine errors don't blend into the page.
 * For the full-page "this thing failed entirely" state (where the
 * banner replaces page content rather than sitting above it), wrap this
 * in a Card. For the inline "this field is wrong" state, prefer Label
 * + the Input's invalid prop — this primitive is for whole-section
 * failures and recoveries.
 */

type Severity = 'error' | 'warning' | 'info';

const SEVERITY: Record<
  Severity,
  { icon: typeof AlertCircle; className: string }
> = {
  error: {
    icon: AlertCircle,
    className: 'border-alert/60 bg-alert/15 text-alert',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-warning/60 bg-warning/15 text-warning',
  },
  info: {
    icon: Info,
    className: 'border-steel/60 bg-steel/15 text-sky',
  },
};

interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The message to display. Strings/JSX both fine. */
  children: React.ReactNode;
  /** Hide the leading alert icon. Defaults to showing it. */
  hideIcon?: boolean;
  /** Severity tier. Defaults to "error" so the 44+ existing call sites keep their meaning. */
  severity?: Severity;
}

export function ErrorBanner({
  children,
  hideIcon,
  severity = 'error',
  className,
  ...rest
}: ErrorBannerProps) {
  const { icon: Icon, className: severityCls } = SEVERITY[severity];
  return (
    <div
      role={severity === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        severityCls,
        className,
      )}
      {...rest}
    >
      {!hideIcon && (
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
