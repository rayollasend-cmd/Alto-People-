import { describe, expect, it } from 'vitest';
import {
  NAVIGABLE_FILE_PATTERN,
  htmlErrorPage,
  isBrowserNavigation,
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
