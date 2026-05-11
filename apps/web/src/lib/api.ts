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

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
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
  const { body, headers, ...rest } = options;
  const init: RequestInit = {
    credentials: 'include',
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new NetworkError(err);
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
