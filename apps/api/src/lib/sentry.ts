import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

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
  });
}

/**
 * Lightweight wrapper around Sentry.captureException that's safe to call
 * even when the SDK wasn't initialised (DSN unset). Lets call sites
 * report errors without a feature-gate `if (env.SENTRY_DSN)` everywhere.
 */
export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export { Sentry };
