export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
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
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `Request failed (${res.status})`,
      err?.details
    );
  }

  return parsed as T;
}
