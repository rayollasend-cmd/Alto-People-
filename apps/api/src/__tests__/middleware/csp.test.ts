import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

/**
 * The browser app is served by this API, so this one Content-Security-Policy
 * header is the whole front-end's policy.
 *
 * Two things must stay true at once:
 *   - WebAssembly must be allowed to compile ('wasm-unsafe-eval'), because
 *     the document scanner ships OpenCV as wasm. Without it the browser
 *     refuses to instantiate the module and scanning silently degrades.
 *   - Plain string evaluation must stay banned ('unsafe-eval' must NOT be
 *     present), because that re-opens eval()/new Function() for every
 *     script on the page — the exact thing CSP exists to stop.
 *
 * Token-aware matching matters here: "'wasm-unsafe-eval'" contains the
 * substring "unsafe-eval", so a naive includes() check would pass forever.
 */
function scriptSrcTokens(csp: string): string[] {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === 'script-src' || d.startsWith('script-src '));
  if (!directive) return [];
  return directive.split(/\s+/).slice(1);
}

describe('Content-Security-Policy', () => {
  it('allows WebAssembly compilation but not string evaluation', async () => {
    const res = await request(createApp()).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();

    const tokens = scriptSrcTokens(csp);
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-inline'");
  });

  it('keeps the Sentry ingest hosts on connect-src', async () => {
    const res = await request(createApp()).get('/health');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://*.ingest.us.sentry.io');
  });
});
