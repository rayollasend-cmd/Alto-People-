import { useState } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { AlertOctagon, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Phase 71 — global router fallback. React Router calls this when a route's
 * component throws during render or when a loader rejects. Without it the
 * user sees a blank page; this gives them a bounce-back path + a
 * collapsible technical block so support can see what happened.
 *
 * The error ID is timestamp-based — not cryptographically meaningful, just
 * something a user can quote in a support ticket.
 */
export function RouterErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const [showDetails, setShowDetails] = useState(false);

  const errorId = `ERR-${Date.now().toString(36).toUpperCase()}`;
  const { headline, detail } = describeError(error);

  return (
    <div className="min-h-screen flex items-center justify-center bg-midnight text-white p-6">
      <div className="max-w-lg w-full bg-navy border border-navy-secondary rounded-lg p-8 text-center">
        <div className="mx-auto mb-5 h-14 w-14 rounded-full bg-alert/15 border border-alert/30 grid place-items-center">
          <AlertOctagon className="h-7 w-7 text-alert" aria-hidden="true" />
        </div>
        <h1 className="font-display text-2xl text-white mb-2">{headline}</h1>
        <p className="text-sm text-silver mb-1">
          The page hit an unexpected error and couldn&apos;t load.
        </p>
        <p className="text-xs text-silver/80 mb-6 tabular-nums">
          Reference: <span className="font-mono text-silver">{errorId}</span>
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" />
            Reload page
          </Button>
          <Button variant="outline" onClick={() => navigate('/')}>
            <Home className="h-4 w-4" />
            Back to dashboard
          </Button>
        </div>

        <div className="mt-6 text-left">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs uppercase tracking-widest text-silver/80 hover:text-silver focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
            aria-expanded={showDetails}
          >
            {showDetails ? 'Hide' : 'Show'} technical details
          </button>
          {showDetails && (
            <pre className="mt-3 max-h-60 overflow-auto rounded-md bg-midnight border border-navy-secondary p-3 text-xs text-silver/90 whitespace-pre-wrap break-words">
              {detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function describeError(error: unknown): { headline: string; detail: string } {
  if (isRouteErrorResponse(error)) {
    return {
      headline: `${error.status} ${error.statusText || 'Error'}`,
      detail:
        typeof error.data === 'string'
          ? error.data
          : JSON.stringify(error.data ?? {}, null, 2),
    };
  }
  if (error instanceof Error) {
    return {
      headline: 'Something went wrong',
      detail: `${error.name}: ${error.message}\n\n${error.stack ?? ''}`.trim(),
    };
  }
  return {
    headline: 'Something went wrong',
    detail: String(error ?? 'Unknown error'),
  };
}
