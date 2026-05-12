import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Sentry } from '@/lib/sentry';
import { ApiError } from '@/lib/api';

/**
 * Top-level error boundary mounted at the React root.
 *
 * Catches errors that propagate out of render / lifecycle / effects of
 * the entire app tree. Without this, an unhandled throw from any page's
 * render path unmounts the whole subtree — the user sees a blank white
 * box and nothing tells us. With this:
 *
 *   - The error is reported to Sentry (no-op if VITE_SENTRY_DSN is
 *     unset).
 *   - The user sees a styled fallback with the requestId (if the error
 *     was an ApiError carrying one) so support can correlate to logs.
 *   - "Try again" reloads the page rather than retrying the broken
 *     subtree — broken subtrees rarely recover from re-render alone.
 *
 * Per-route boundaries (e.g. around individual data widgets) can still
 * sit lower in the tree; this is the last-resort net.
 */
interface State {
  error: Error | null;
}

export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Sentry.captureException no-ops when DSN unset. Component stack is
    // the most useful extra to attach — points at which subtree blew up.
    Sentry.captureException(error, {
      extra: { componentStack: info.componentStack },
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    const requestId = err instanceof ApiError ? err.requestId : undefined;
    return (
      <div className="min-h-screen flex items-center justify-center bg-midnight p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="font-display text-2xl text-gold">Something broke</div>
          <p className="text-sm text-silver">
            We logged the error and the team has been notified. Refreshing
            usually fixes it.
          </p>
          {requestId && (
            <p className="text-xs text-silver/60 font-mono">
              Trace: {requestId}
            </p>
          )}
          <div className="flex justify-center gap-2 pt-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-navy hover:bg-gold-bright"
            >
              Reload
            </button>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.history.back();
              }}
              className="rounded-md border border-navy-secondary px-4 py-2 text-sm text-white hover:bg-navy-secondary/40"
            >
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }
}
