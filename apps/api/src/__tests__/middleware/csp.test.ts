import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

/**
 * The browser app is served by this API, so this one Content-Security-Policy
 * header is the whole front-end's policy.
 *
 * This file used to assert that 'unsafe-eval' was NOT present, on the
 * reasoning that the document scanner only needed WebAssembly to compile.
 * That reasoning was incomplete. OpenCV (scanning) and libheif via heic2any
 * (HEIC uploads) are both Emscripten builds using embind, and embind
 * assembles its argument-wiring and method-caller trampolines with
 * `new Function(...)` on every bound call. That is ordinary JavaScript
 * evaluation, which 'wasm-unsafe-eval' does not permit — so the .wasm
 * instantiated and the first call into it was blocked instead.
 *
 * So 'unsafe-eval' is present now, deliberately, and this file's job
 * changes: pin the widening to exactly that one token, and keep every
 * other protection asserted so the next edit can't quietly widen further.
 * The narrow fix — moving both libraries into Web Workers served with
 * their own looser CSP — would let this go back; see app.ts.
 *
 * Token-aware matching matters here: "'wasm-unsafe-eval'" contains the
 * substring "unsafe-eval", so a naive includes() check would be meaningless
 * in both directions.
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
  it('allows the embind libraries to evaluate, and nothing else', async () => {
    const res = await request(createApp()).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();

    const tokens = scriptSrcTokens(csp);
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("'wasm-unsafe-eval'");
    // The deliberate widening — embind's new Function() trampolines.
    expect(tokens).toContain("'unsafe-eval'");
    // Still banned: inline <script> and injected event handlers, which is
    // the half of the policy that stops reflected/stored XSS from running.
    expect(tokens).not.toContain("'unsafe-inline'");
    // No remote script origins crept in alongside the eval widening.
    expect(tokens.filter((t) => !t.startsWith("'"))).toEqual([]);
  });

  it('lets the vans map load its tiles, without opening blob: workers', async () => {
    const res = await request(createApp()).get('/health');
    const csp = res.headers['content-security-policy'] as string;
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src '));
    expect(connect).toContain('https://tiles.openfreemap.org');
    expect(csp).not.toMatch(/blob:/);
  });

  it('keeps the Sentry ingest hosts on connect-src', async () => {
    const res = await request(createApp()).get('/health');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://*.ingest.us.sentry.io');
  });
});
