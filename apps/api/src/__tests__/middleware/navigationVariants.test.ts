import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

/**
 * One URL, two answers — say so, or a cache will mix them.
 *
 * Most paths on this origin serve both an SPA page and a JSON API
 * resource: /jobs is the page and the jobs list, and so are /separations,
 * /reports and a dozen more. Which one you get depends on the request
 * headers, which makes every such response a negotiated variant. Without
 * `Vary` naming the headers it negotiated on, any shared cache between
 * the server and the browser may replay the JSON variant for a page load
 * — which is how refreshing a page intermittently rendered raw JSON.
 */

const NAVIGATION = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
};

const FETCH_CALL = {
  Accept: '*/*',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

const varyOf = (res: request.Response): string[] =>
  String(res.headers.vary ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

describe('page vs JSON on the same URL', () => {
  it('names every header the answer depends on', async () => {
    const res = await request(createApp()).get('/jobs').set(FETCH_CALL);
    const vary = varyOf(res);
    expect(vary).toContain('accept');
    expect(vary).toContain('sec-fetch-mode');
    expect(vary).toContain('sec-fetch-dest');
  });

  it('keeps business JSON out of shared caches', async () => {
    const res = await request(createApp()).get('/jobs').set(FETCH_CALL);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers a page load with the page, whatever the router would say', async () => {
    const res = await request(createApp()).get('/jobs').set(NAVIGATION);
    // No web build in CI, so the shell middleware answers with its
    // "refresh in a moment" HTML rather than index.html. Either way the
    // contract holds: a navigation is never given JSON.
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(varyOf(res)).toContain('sec-fetch-mode');
  });

  it('still gives an API client JSON on the same path', async () => {
    const res = await request(createApp()).get('/jobs').set(FETCH_CALL);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
