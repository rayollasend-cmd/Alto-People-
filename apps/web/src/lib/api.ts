import {
  emitApiAuthFailure,
  emitApiConnectivity,
  isAuthFlowPath,
} from './sessionEvents';
import { nativeHeaders } from './native/platform';

/**
 * What a person reads when the server refuses for a capability their role
 * doesn't hold. The API answers "Missing capability: view:recruiting" — a
 * line for logs, never for a screen (deep audit 2026-10-29, CRAWL-11: 27
 * page loads printed it). Every page that shows `err.message` reads plain
 * words instead; the capability stays on `ApiError.capability` for logic.
 */
export const NO_ACCESS_MESSAGE = 'You don’t have access to this.';
const CAPABILITY_REFUSAL = /^\s*missing capabilit(?:y|ies)\b:?\s*(?:one of\s*)?(.*)$/i;

export class ApiError extends Error {
  /** The capability (or "a, b" list) a refusal named — for logic and logs, never shown. */
  public readonly capability?: string;
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    // Per-request trace ID, surfaced in the response body by the API's
    // error handler. Useful to quote in support tickets so ops can grep
    // server logs for the matching trace.
    public readonly requestId?: string,
  ) {
    const refusal = CAPABILITY_REFUSAL.exec(message ?? '');
    super(refusal ? NO_ACCESS_MESSAGE : message);
    this.name = 'ApiError';
    if (refusal) this.capability = refusal[1]!.trim() || undefined;
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Network request failed');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Thrown when a request exceeds REQUEST_TIMEOUT_MS. Distinct from
 * NetworkError so callers (and the global error UI) can say "the server is
 * taking too long" rather than "you're offline".
 */
export class TimeoutError extends Error {
  constructor() {
    super(
      "The server didn't respond in time — it may be waking up. Please try again in a moment.",
    );
    this.name = 'TimeoutError';
  }
}

// Hard ceiling. Generous on purpose: a cold Railway container + Neon wake can
// take the better part of a minute, and we'd rather let that complete than
// abort a real request. Past this, the request is almost certainly wedged, so
// we fail cleanly instead of spinning forever.
const REQUEST_TIMEOUT_MS = 90_000;

// After this long we show a single shared "waking up" indicator WITHOUT
// aborting — the request keeps going, the user just gets feedback instead of a
// dead spinner. Tuned above a normal warm response (which is well under 1s) so
// it only fires on genuine cold starts / stalls.
const SLOW_NOTICE_MS = 6_000;

// Coalesce concurrent slow requests into one toast (a page can fire several
// queries at once on a cold backend — we don't want five identical toasts).
let slowInFlight = 0;
const SLOW_TOAST_ID = 'api-slow-request';

function noteSlowStart(): void {
  slowInFlight += 1;
  if (slowInFlight === 1) {
    void import('sonner').then(({ toast }) =>
      toast.loading('Still loading — the server may be waking up…', {
        id: SLOW_TOAST_ID,
        duration: Infinity,
      }),
    );
  }
}

function noteSlowEnd(): void {
  slowInFlight = Math.max(0, slowInFlight - 1);
  if (slowInFlight === 0) {
    void import('sonner').then(({ toast }) => toast.dismiss(SLOW_TOAST_ID));
  }
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Override the default 90s hard timeout for unusually long operations. */
  timeoutMs?: number;
}

/**
 * Thin fetch wrapper. Uses the Vite dev proxy in dev (`/api/*` → 3001)
 * and same-origin in prod. Cookies are always sent.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const url = path.startsWith('/') ? `/api${path}` : `/api/${path}`;
  const { body, headers, timeoutMs, signal: externalSignal, ...rest } = options;

  // Own AbortController drives the timeout; forward any caller-supplied signal
  // so existing cancellation still works.
  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else
      externalSignal.addEventListener(
        'abort',
        () => controller.abort(externalSignal.reason),
        { once: true },
      );
  }

  const init: RequestInit = {
    credentials: 'include',
    ...rest,
    signal: controller.signal,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // Inside the native app: which phone this is (lib/native/platform).
      ...nativeHeaders(),
      ...(headers ?? {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let timedOut = false;
  let sawSlow = false;
  const slowTimer = setTimeout(() => {
    sawSlow = true;
    noteSlowStart();
  }, SLOW_NOTICE_MS);
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs ?? REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A caller-driven abort (component unmount, superseded query) says
    // nothing about the network — only our own timeout or a genuine
    // fetch failure count as connectivity loss.
    if (timedOut) {
      emitApiConnectivity('offline');
      throw new TimeoutError();
    }
    if (!externalSignal?.aborted) emitApiConnectivity('offline');
    throw new NetworkError(err);
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    if (sawSlow) noteSlowEnd();
  }

  // Any response at all — even a 4xx/5xx — proves the network path is
  // alive again. (The bus dedupes, so this is a no-op while online.)
  emitApiConnectivity('online');

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body, ignore */
  }

  if (!res.ok) throw refusal(res, parsed, path);

  return parsed as T;
}

/** The ApiError for a refused response, from its error envelope. */
function refusal(res: Response, parsed: unknown, path: string): ApiError {
  const err = (parsed as {
    error?: { code?: string; message?: string; details?: unknown; requestId?: string };
  } | null)?.error;
  // Prefer the body's requestId (always present on server-side errors)
  // but fall back to the X-Request-Id response header — covers cases
  // where helmet / CORS preflights respond without our error envelope.
  const requestId = err?.requestId ?? res.headers.get('x-request-id') ?? undefined;
  // Session death signal. Auth-flow endpoints are excluded: a 401 from
  // login / reset / invite / passkey verification is a normal
  // wrong-credentials outcome, not an expired session.
  if (res.status === 401 && !isAuthFlowPath(path)) {
    emitApiAuthFailure(path);
  }
  return new ApiError(
    res.status,
    err?.code ?? `http_${res.status}`,
    err?.message ?? `Request failed (${res.status})`,
    err?.details,
    requestId,
  );
}

/** Whether this browser can read a response as it arrives. */
export function canStream(): boolean {
  return typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined' && typeof Response !== 'undefined' && 'body' in Response.prototype;
}

/**
 * POST a body and read the answer as it is made: newline-delimited JSON,
 * each line handed to `onLine` as it lands (POST /hugo/ask/stream). A
 * refusal before the stream opens throws an ApiError, as apiFetch does;
 * the whole exchange is bounded by `timeoutMs`.
 */
export async function apiStream(path: string, body: unknown, onLine: (line: unknown) => void, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  const controller = new AbortController();
  const external = opts.signal;
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json', ...nativeHeaders() },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (timedOut) {
        emitApiConnectivity('offline');
        throw new TimeoutError();
      }
      if (!external?.aborted) emitApiConnectivity('offline');
      throw new NetworkError(err);
    }
    emitApiConnectivity('online');
    if (!res.ok || !res.body) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* empty body, ignore */
      }
      throw refusal(res, parsed, path);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) onLine(JSON.parse(line));
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) onLine(JSON.parse(rest));
  } finally {
    clearTimeout(timer);
  }
}
