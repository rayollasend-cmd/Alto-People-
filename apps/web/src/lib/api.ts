export class ApiError extends Error {
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
    super(message);
    this.name = 'ApiError';
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
    if (timedOut) throw new TimeoutError();
    throw new NetworkError(err);
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    if (sawSlow) noteSlowEnd();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body, ignore */
  }

  if (!res.ok) {
    const err = (parsed as {
      error?: { code?: string; message?: string; details?: unknown; requestId?: string };
    } | null)?.error;
    // Prefer the body's requestId (always present on server-side errors)
    // but fall back to the X-Request-Id response header — covers cases
    // where helmet / CORS preflights respond without our error envelope.
    const requestId = err?.requestId ?? res.headers.get('x-request-id') ?? undefined;
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
      requestId,
    );
  }

  return parsed as T;
}
