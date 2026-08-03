import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { scrubDeep, stripUrlSecrets } from '@alto-people/shared';

/**
 * Sentry initialization. Called once at process boot, BEFORE any other
 * module imports that might throw (Sentry's auto-instrumentation hooks
 * Node's HTTP layer at import time).
 *
 * When SENTRY_DSN is unset (dev / CI default) this is a no-op: no SDK
 * spin-up, no network calls, no impact on cold-start. The downstream
 * `captureException` helper still works — it just routes to console.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Don't capture noisy AbortError / ECONNRESET that happen when a
    // browser cancels an in-flight request. They're not errors, they're
    // user behaviour.
    ignoreErrors: [
      'AbortError',
      'ECONNRESET',
      'ECONNABORTED',
      // 4xx HttpErrors are expected (validation, auth) — we throw them
      // intentionally, no point reporting.
      'HttpError',
    ],
    // The API sees SSNs, bank details and PINs. Strip query strings and
    // censor sensitive-looking keys from request data and extra context
    // before anything leaves the process.
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = stripUrlSecrets(event.request.url);
      }
      if (event.request?.query_string) event.request.query_string = '[redacted]';
      if (event.request?.data) {
        event.request.data = scrubDeep(event.request.data) as typeof event.request.data;
      }
      if (event.request?.cookies) event.request.cookies = { redacted: 'true' };
      if (event.request?.headers) {
        event.request.headers = scrubDeep(event.request.headers) as typeof event.request.headers;
      }
      if (event.extra) event.extra = scrubDeep(event.extra) as typeof event.extra;
      return event;
    },
  });
}

/**
 * Lightweight wrapper around Sentry.captureException that's safe to call
 * even when the SDK wasn't initialised (DSN unset). Lets call sites
 * report errors without a feature-gate `if (env.SENTRY_DSN)` everywhere.
 */
export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(
    err,
    // Call sites pass arbitrary domain objects here; scrub before send.
    context ? { extra: scrubDeep(context) as Record<string, unknown> } : undefined,
  );
}

export { Sentry };
