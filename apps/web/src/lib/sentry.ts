// PERF: named imports only. The old `import * as Sentry` + namespace
// re-export defeated tree-shaking, so the whole SDK core rode in the
// blocking react-vendor chunk even with no DSN configured.
import { captureException, init } from '@sentry/react';
import { scrubDeep, stripUrlSecrets } from '@alto-people/shared';

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
  init({
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
    // This app handles SSNs, bank details and PINs; error telemetry must
    // not become a side channel into them. Query strings are stripped
    // from URLs and sensitive-looking keys censored before send.
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = stripUrlSecrets(event.request.url);
      }
      if (event.request?.query_string) event.request.query_string = '[redacted]';
      if (event.request?.data) {
        event.request.data = scrubDeep(event.request.data) as typeof event.request.data;
      }
      if (event.extra) event.extra = scrubDeep(event.extra) as typeof event.extra;
      if (event.contexts) {
        event.contexts = scrubDeep(event.contexts) as typeof event.contexts;
      }
      return event;
    },
    beforeBreadcrumb(crumb) {
      if (typeof crumb.data?.url === 'string') {
        crumb.data.url = stripUrlSecrets(crumb.data.url);
      }
      // DOM breadcrumbs echo typed input on some integrations — drop the
      // payload and keep only the fact that an interaction happened.
      if (crumb.category === 'ui.input') return null;
      if (crumb.data) crumb.data = scrubDeep(crumb.data) as typeof crumb.data;
      return crumb;
    },
  });
}

export { captureException };
