import * as Sentry from '@sentry/react';

/**
 * Initialise Sentry on the browser. Reads VITE_SENTRY_DSN at build time
 * (Vite inlines `import.meta.env.VITE_*` literals) so this stays a
 * no-op when the env var is unset — no SDK code paths execute, no
 * network calls, nothing.
 *
 * Called from main.tsx BEFORE React mounts so the integration is in
 * place by the time the first lazy chunk could throw.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Same conservative default as the API side. Bumpable per env via
    // VITE_SENTRY_TRACES_SAMPLE_RATE if you want richer traces.
    tracesSampleRate: Number(
      import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
    ),
    // Suppress ResizeObserver / network-cancel noise so the dashboard
    // shows real bugs only.
    ignoreErrors: [
      'ResizeObserver loop',
      'Non-Error promise rejection captured',
      'AbortError',
      'NetworkError',
      'TimeoutError',
    ],
  });
}

export { Sentry };
