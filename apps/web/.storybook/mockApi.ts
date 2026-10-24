/**
 * A fake API for stories: every `/api/*` fetch the component makes is
 * answered from the story's `parameters.api` list — no network, no MSW
 * service worker, nothing to install. The app's own apiFetch (lib/api.ts)
 * runs unchanged, so a component sees exactly the ApiError / NetworkError /
 * TimeoutError it would see in production.
 *
 *   parameters: {
 *     api: [
 *       { path: '/comp/associates/:id/hire-pay', body: status },
 *       { method: 'POST', path: '/comp/associates/:id/records', body: { ok: true } },
 *       { path: /^\/geo\/address-suggest/, body: { results, provider: 'mapbox' } },
 *       { path: '/slow', delay: Infinity },          // stays loading
 *       { path: '/down', networkError: true },        // the offline state
 *       { path: '/forbidden', status: 403, body: { error: { code: 'forbidden', message: 'Missing capability' } } },
 *     ],
 *   }
 *
 * A request no mock matches answers 404 (and warns in the console), so a
 * missing mock shows up as the component's not-found state, never as a
 * real network call.
 */

export interface ApiRequest {
  method: string;
  /** The path the app asked for, without the /api prefix. */
  path: string;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

export interface ApiMock {
  /** Default GET. */
  method?: string;
  /** '/comp/associates/:id/hire-pay' (`:name` matches one segment) or a RegExp tested against path + query. */
  path: string | RegExp;
  /** Default 200. */
  status?: number;
  /** The JSON answer, or a function of the request. */
  body?: unknown | ((req: ApiRequest) => unknown);
  /** Milliseconds before answering. `Infinity` never answers: the loading state. */
  delay?: number;
  /** Fail like a dropped connection (the app's NetworkError → "offline"). */
  networkError?: boolean;
}

let mocks: ApiMock[] = [];
let installed = false;

function matchPath(pattern: string | RegExp, path: string, search: string): Record<string, string> | null {
  if (pattern instanceof RegExp) return pattern.test(path + search) ? {} : null;
  const want = pattern.split('?')[0].split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = Number.isFinite(ms) ? window.setTimeout(resolve, ms) : undefined;
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(abortError());
    });
  });
}

function json(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'story-request' },
  });
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = url.pathname.slice('/api'.length);
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    for (const mock of mocks) {
      if ((mock.method ?? 'GET').toUpperCase() !== method) continue;
      const params = matchPath(mock.path, path, url.search);
      if (!params) continue;
      if (mock.delay) await wait(mock.delay, init?.signal);
      if (mock.networkError) throw new TypeError('Failed to fetch');
      const answer = typeof mock.body === 'function' ? (mock.body as (r: ApiRequest) => unknown)({ method, path, url, params, body }) : mock.body;
      return json(mock.status ?? 200, answer);
    }

    console.warn(`[storybook] no API mock for ${method} ${path}${url.search} — answering 404`);
    return json(404, { error: { code: 'not_found', message: `No mock for ${method} ${path}` } });
  };
}

/** Replace the mocks (called before every story renders). */
export function setApiMocks(next: ApiMock[] | undefined): void {
  install();
  mocks = next ?? [];
}
