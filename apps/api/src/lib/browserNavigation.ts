// Browser-navigation detection + HTML fallbacks — the "no raw JSON in a
// browser, ever" toolkit. Three layers use it (app.ts shell middleware,
// middleware/error.ts, and the 404 handler), so the classification logic
// lives here once and is unit-tested against real browser header sets
// (__tests__/lib/browserNavigation.test.ts).

/** The subset of an Express request the classifier needs — kept minimal so
 *  tests can exercise it with plain objects. */
export interface NavigationProbe {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Destinations that paint a document. JSON in any of these is visible
 *  garbage on someone's screen. */
const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/** Destinations that are unambiguously a subresource fetch, never a page. */
const SUBRESOURCE_DESTS = new Set([
  'empty',
  'script',
  'style',
  'image',
  'font',
  'audio',
  'video',
  'track',
  'worker',
  'sharedworker',
  'serviceworker',
  'manifest',
  'xslt',
  'report',
  'paintworklet',
  'audioworklet',
]);

/**
 * True when this request is a top-level browser PAGE LOAD (address-bar
 * entry, link click, refresh) — the case where sending JSON would render
 * raw data on the user's screen.
 *
 * Three signals, each consulted only where it actually says something:
 *
 *  1. Sec-Fetch-Dest, when it is a value we recognise. A document-ish
 *     destination is a page load; a subresource destination never is,
 *     whatever else the request claims.
 *  2. Sec-Fetch-Mode, when the destination was missing or unrecognised.
 *     `navigate` is a page load; `cors` / `same-origin` / `no-cors` is a
 *     subresource fetch.
 *  3. Content negotiation, when no Sec-Fetch header survived at all
 *     (Safari before 16.4, iOS in-app webviews, older browsers): a page
 *     load asks for text/html first; fetch()/XHR send the wildcard or
 *     application/json, images ask for image types, calendar pollers
 *     text/calendar — none of them ever claim text/html.
 *
 * Reading the pair as a unit — "navigate AND document, or it isn't a
 * page" — is what put this bug back. Some intermediaries (corporate
 * proxies, security appliances, a few webviews) forward Sec-Fetch-Mode
 * and drop Sec-Fetch-Dest. A signed-in manager refreshing /clients
 * through one of those was classified as a subresource fetch, the
 * `Accept: text/html` sitting right there in the request was never
 * consulted, and the API list rendered in the address bar as
 * `{"clients":[…]}`. A missing header is missing information, not
 * evidence against.
 */
export function isBrowserNavigation(req: NavigationProbe): boolean {
  if (req.method !== 'GET') return false;
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.toLowerCase();
  };

  const dest = header('sec-fetch-dest');
  if (dest) {
    if (DOCUMENT_DESTS.has(dest)) return true;
    if (SUBRESOURCE_DESTS.has(dest)) return false;
    // An unknown destination tells us nothing; keep looking.
  }

  const mode = header('sec-fetch-mode');
  if (mode === 'navigate') return true;
  if (mode) return false;

  const accept = req.headers.accept;
  const acceptStr = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return acceptStr.includes('text/html');
}

/**
 * File-download URLs that browsers open via <a href> navigation ON
 * PURPOSE — these must keep returning their bytes to navigations
 * (document/paystub/packet PDFs, CSV/ZIP exports, calendar feeds), so the
 * SPA-shell middleware skips them. When one of these FAILS, the error
 * handler still owes the browser HTML, not JSON — that's htmlErrorPage.
 */
/**
 * A request for a built file rather than a page: the hashed bundles under
 * /assets, plus anything else carrying a file extension (source maps,
 * icons, the web manifest, face models).
 *
 * These must never be answered with the SPA shell. Handing back HTML
 * where a module was expected is what turns "this tab has been open
 * since the last deploy" into "Failed to fetch dynamically imported
 * module" — a message that names neither the cause nor the cure.
 */
export function isBuildArtifactRequest(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.') && !last.startsWith('.');
}

export const NAVIGABLE_FILE_PATTERN = /\.(pdf|zip|csv|ics)$|\/(download|pdf)(\/|$)/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PAGE_STYLE = [
  'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#0f1f38;color:#e8eaf0;',
  "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;",
].join('');

/**
 * A small, self-contained, branded HTML page for the rare case where a
 * browser navigation must be answered with an error (an expired download
 * link, a 404 on a file URL, the web bundle missing mid-deploy). Never
 * echoes request input other than the server-generated request id.
 */
export function htmlErrorPage(opts: {
  status: number;
  title: string;
  message: string;
  requestId?: string;
}): string {
  const rid = opts.requestId
    ? `<p style="margin:24px 0 0;font-size:12px;color:#8b93a7">Request ID: <code>${escapeHtml(opts.requestId)}</code></p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)} — Alto People</title></head>
<body style="${PAGE_STYLE}">
<main style="max-width:420px;padding:48px 32px;text-align:center">
<p style="margin:0 0 8px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#c9a34a;font-weight:600">Alto People</p>
<h1 style="margin:0 0 12px;font-size:22px;font-weight:700">${escapeHtml(opts.title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#b8bfcf">${escapeHtml(opts.message)}</p>
<p style="margin:28px 0 0"><a href="/" style="display:inline-block;padding:10px 22px;border-radius:8px;background:#c9a34a;color:#0f1f38;font-weight:600;font-size:14px;text-decoration:none">Back to Alto People</a></p>
${rid}
</main></body></html>`;
}

/** Friendly title/message pairs for the statuses navigations actually hit. */
export function htmlErrorCopy(status: number): { title: string; message: string } {
  if (status === 401) {
    return {
      title: 'Please sign in',
      message: 'Your session has ended. Head back to Alto People and sign in again to open this.',
    };
  }
  if (status === 403) {
    return {
      title: 'No access to this',
      message: "Your account doesn't have permission to open this link.",
    };
  }
  if (status === 404 || status === 410) {
    return {
      title: 'Not found',
      message: "This link doesn't point to anything anymore. It may have expired or been replaced.",
    };
  }
  if (status === 503) {
    return {
      title: 'Just a moment',
      message: 'Alto People is finishing an update. Refresh in a few seconds.',
    };
  }
  return {
    title: 'Something went wrong',
    message: 'That request could not be completed. Try again, or head back to Alto People.',
  };
}
