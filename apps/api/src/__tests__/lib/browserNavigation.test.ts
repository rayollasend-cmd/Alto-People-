import { describe, expect, it } from 'vitest';
import {
  NAVIGABLE_FILE_PATTERN,
  htmlErrorPage,
  isBrowserNavigation,
  isBuildArtifactRequest,
} from '../../lib/browserNavigation.js';

/**
 * The "no raw JSON in a browser, ever" classifier. These fixtures are the
 * header sets real clients actually send — if a change here breaks Safari
 * or starts serving HTML to integrations, these tests catch it before a
 * user does.
 */

const nav = (headers: Record<string, string>) =>
  isBrowserNavigation({ method: 'GET', headers });

describe('isBrowserNavigation — page loads (must get HTML)', () => {
  it('Chrome/Edge/Firefox address-bar load (Sec-Fetch present)', () => {
    expect(
      nav({
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
      }),
    ).toBe(true);
  });

  it('Safari 15 / iOS in-app webview load (NO Sec-Fetch headers at all)', () => {
    expect(
      nav({ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
    ).toBe(true);
  });
});

describe('isBrowserNavigation — API clients (must keep getting JSON)', () => {
  it("the SPA's own fetch() data calls (Sec-Fetch says cors)", () => {
    expect(
      nav({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: '*/*' }),
    ).toBe(false);
  });

  it('Safari 15 fetch() (no Sec-Fetch, default Accept: */*)', () => {
    expect(nav({ accept: '*/*' })).toBe(false);
  });

  it('integration clients asking for JSON', () => {
    expect(nav({ accept: 'application/json' })).toBe(false);
  });

  it('curl / SDKs with no Accept header at all', () => {
    expect(nav({})).toBe(false);
  });

  it('calendar feed pollers', () => {
    expect(nav({ accept: 'text/calendar, */*' })).toBe(false);
  });

  it('image subresource requests', () => {
    expect(
      nav({
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
        accept: 'image/avif,image/webp,*/*',
      }),
    ).toBe(false);
  });

  it('Sec-Fetch, when present, outranks a text/html Accept (proxies that add Accept)', () => {
    expect(
      nav({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'text/html' }),
    ).toBe(false);
  });

  // The regression that put raw JSON back on /clients. Some proxies,
  // security appliances and webviews forward one Sec-Fetch header and
  // drop the other; reading the pair as an all-or-nothing unit turned a
  // page load into a subresource fetch and handed the API list to the
  // address bar.
  it('a navigation whose Sec-Fetch-Dest was stripped is still a navigation', () => {
    expect(nav({ 'sec-fetch-mode': 'navigate', accept: 'text/html,*/*;q=0.8' })).toBe(true);
  });

  it('a navigation whose Sec-Fetch-Mode was stripped is still a navigation', () => {
    expect(nav({ 'sec-fetch-dest': 'document', accept: 'text/html,*/*;q=0.8' })).toBe(true);
  });

  it('the destination wins over a mode that disagrees with it', () => {
    // A fetch() that somehow claims navigate mode is still a fetch.
    expect(nav({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' })).toBe(false);
    // …and a document is a document however it was initiated.
    expect(nav({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'document' })).toBe(true);
  });

  it('a framed document is a document — JSON would render in the frame', () => {
    expect(nav({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })).toBe(true);
  });

  it('header case and array values do not change the answer', () => {
    expect(nav({ 'sec-fetch-mode': 'NAVIGATE', 'sec-fetch-dest': 'DOCUMENT' })).toBe(true);
    expect(
      isBrowserNavigation({
        method: 'GET',
        headers: { 'sec-fetch-dest': ['document'], accept: 'text/html' },
      }),
    ).toBe(true);
  });

  it('non-GET is never a navigation, whatever the headers', () => {
    expect(
      isBrowserNavigation({
        method: 'POST',
        headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    ).toBe(false);
  });
});

describe('NAVIGABLE_FILE_PATTERN — download URLs stay downloadable', () => {
  it('matches file endpoints that browsers open via <a href>', () => {
    for (const p of [
      '/documents/abc/download',
      '/me/tax-documents/xyz/download',
      '/tax-forms/w2/bulk.zip',
      '/payroll/new-hire-report.csv',
      '/tax-forms/123/pdf',
      '/calendar-feed/token.ics',
      '/audit/logs.csv',
    ]) {
      expect(NAVIGABLE_FILE_PATTERN.test(p), p).toBe(true);
    }
  });

  it('does NOT match SPA page paths', () => {
    for (const p of ['/users', '/scheduling', '/reports', '/separations', '/ops', '/pdfviewer']) {
      expect(NAVIGABLE_FILE_PATTERN.test(p), p).toBe(false);
    }
  });
});

describe('htmlErrorPage', () => {
  it('escapes the request id — nothing reflected can execute', () => {
    const html = htmlErrorPage({
      status: 404,
      title: 'Not found',
      message: 'Gone.',
      requestId: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<!doctype html>');
  });
});

/**
 * A deploy content-hashes every bundle, so a tab open across one asks for
 * files the server no longer has. Those requests must 404 rather than
 * fall through to the SPA shell: HTML where a module was expected is what
 * the browser reports as "Failed to fetch dynamically imported module".
 */
describe('isBuildArtifactRequest', () => {
  it('claims the hashed bundles and anything else with an extension', () => {
    for (const p of [
      '/assets/AdminDashboard-BfLLMHRD.js',
      '/assets/index-abc123.css',
      '/assets/logo.svg',
      '/favicon.svg',
      '/manifest.webmanifest',
      '/face-models/tiny_face_detector-weights_manifest.json',
      '/sw.js',
    ]) {
      expect(isBuildArtifactRequest(p)).toBe(true);
    }
  });

  it('leaves page paths to the SPA', () => {
    for (const p of [
      '/',
      '/jobs',
      '/portal/today',
      '/time-attendance/timesheets/history/abc',
      '/kiosk',
    ]) {
      expect(isBuildArtifactRequest(p)).toBe(false);
    }
  });
});
