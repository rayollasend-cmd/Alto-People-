import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { scrubDeep, stripUrlSecrets } from '@alto-people/shared';
import { tenantContext } from './tenant.js';

/**
 * Brief 2-1 §9.6: every event carries the tenant it happened for. The
 * request and job wrappers tag their isolation scope (lib/tenantTelemetry);
 * this stamps the tag from the live tenant context at send time for
 * anything captured outside them (an API-key request that switched tenant,
 * a background promise). A tag already set wins.
 */
export function stampTenant<E extends { tags?: Record<string, unknown> }>(event: E): E {
  const ctx = tenantContext();
  if (!ctx || event.tags?.tenant) return event;
  event.tags = { ...event.tags, tenant: ctx.tenantId, tenant_source: ctx.platform ? 'platform' : ctx.source };
  return event;
}

/**
 * Requests not worth a trace: the PostHog relay, health probes, the
 * live-updates stream (open for minutes), web-vitals beacons and the web
 * app's own files. Nov 2026 they were ~44% of requests.
 */
const UNTRACED_PATHS = /^\/(?:api\/)?(?:ux\/|health\/|events\/stream|telemetry\/web-vitals)|^\/(?:assets\/|[^/]+\.(?:js|css|png|svg|ico|webmanifest|json|txt|webp|woff2?|map)$)/;

/**
 * Which traces to keep. A root span with no request behind it — a
 * background job's database call (`prisma:client:operation`) or an
 * outgoing call it made — starts a trace of its own; ~1M a week used up
 * the span quota (Oct 21–26: no API traces kept at all). Requests keep the
 * configured rate, and a request's own spans follow it.
 */
export function sampleTrace(ctx: {
  name: string;
  parentSampled?: boolean;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string };
  inheritOrSampleWith: (fallback: number) => number;
}): number {
  if (ctx.parentSampled === undefined) {
    if (ctx.name.startsWith('prisma:')) return 0;
    const target = ctx.attributes?.['url.path'] ?? ctx.attributes?.['http.target'] ?? ctx.normalizedRequest?.url;
    if (typeof target === 'string') {
      const path = target.replace(/^https?:\/\/[^/]+/, '');
      if (UNTRACED_PATHS.test(path)) return 0;
    }
  }
  return ctx.inheritOrSampleWith(env.SENTRY_TRACES_SAMPLE_RATE);
}

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
  // src/instrument.ts runs this first (node --import); index.ts calls it
  // again as a fallback for a process started without the flag.
  if (Sentry.isInitialized()) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampler: sampleTrace,
    integrations: [
      // One place decides what is a server fault: middleware/error.ts. It
      // answers a ZodError and a malformed id (Prisma P2023) with 400, an
      // upload the phone abandoned with nothing, and reports everything
      // else itself. Sentry 11's Express integration otherwise captures
      // every error that carries no HTTP status — all of those — before
      // that handler runs (ALTO-PEOPLE-API-8, -S, -14, -Y, -X, -T).
      //
      // Spans for the route handler only. A span per middleware and per
      // router hung a 'finish' listener on every response for each layer
      // passed — ~16 on a plain request, 96 on a path that walks every
      // router — so Node warned "MaxListenersExceededWarning" on nearly
      // every request (Nov 2026: ~11 a minute, most of the log), and each
      // kept trace spent ~17 spans on helmet/cors/body parsing. Route names
      // don't depend on them (lib/routeName names the root span).
      Sentry.expressIntegration({ shouldHandleError: false, ignoreLayersType: ['middleware', 'router'] }),
    ],
    // Don't capture noisy AbortError / ECONNRESET that happen when a
    // browser cancels an in-flight request. They're not errors, they're
    // user behaviour.
    ignoreErrors: [
      'AbortError',
      'ECONNRESET',
      'ECONNABORTED',
      // body-parser's own wording when the socket closes before the body
      // finishes arriving — someone navigated away, closed the tab, or
      // lost signal mid-POST. ignoreErrors matches the message, and the
      // message is all this error carries; the codes above never appear
      // in it. The error middleware also swallows it upstream, so this is
      // the backstop for anything captured elsewhere.
      // Case-insensitive: multer says "Request aborted" (capital R), which
      // the plain string never matched.
      /request aborted/i,
      // 4xx HttpErrors are expected (validation, auth) — we throw them
      // intentionally, no point reporting.
      'HttpError',
    ],
    // Sentry 11 collects request bodies, cookies, DB query text and user
    // info BY DEFAULT unless told otherwise. This API sees SSNs, bank
    // details and PINs, so the v10 baseline is pinned explicitly: nothing
    // in these categories leaves the process. (The beforeSend scrub below
    // stays as the backstop for anything captured by hand.)
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user', 'cookie', 'authorization'] },
        response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user', 'set-cookie'] },
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
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
      return stampTenant(event);
    },
    // No beforeSendTransaction: traces are streamed span by span (Sentry 11's
    // default), which ignores it. A request's root span carries its tenant
    // from lib/tenantTelemetry instead.
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
