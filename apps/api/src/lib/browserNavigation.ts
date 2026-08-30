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

/**
 * True when this request is a top-level browser PAGE LOAD (address-bar
 * entry, link click, refresh) — the case where sending JSON would render
 * raw data on the user's screen.
 *
 * Two signals, in order of trust:
 *  1. Sec-Fetch-Mode/Dest (Chrome, Edge, Firefox, Safari 16.4+): when
 *     present, they're authoritative — navigate+document is a page load,
 *     anything else (fetch/XHR = cors/same-origin, images, prefetch
 *     subresources) is not.
 *  2. Content negotiation (Safari before 16.4, iOS in-app webviews, older
 *     browsers send NO Sec-Fetch headers): a top-level page load always
 *     asks for text/html first; fetch()/XHR default to the wildcard Accept
 *     or set application/json, images ask for image types, calendar
 *     pollers text/calendar — none of them ever claim text/html.
 */
export function isBrowserNavigation(req: NavigationProbe): boolean {
  if (req.method !== 'GET') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode !== undefined) {
    return mode === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  }
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
