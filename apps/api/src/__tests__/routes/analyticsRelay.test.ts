import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { POSTHOG_ASSETS, POSTHOG_INGEST, relayTarget } from '../../routes/analyticsRelay.js';

/**
 * The PostHog relay (routes/analyticsRelay.ts): forwards the browser SDK's
 * traffic to PostHog's US cloud and nothing of the person sending it — no
 * session cookie, no authorization header, no client address.
 */

function upstreamReturns(body: string, init: ResponseInit = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, init));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analytics relay', () => {
  it('forwards an event batch byte for byte, to the ingest host, with its query', async () => {
    const fetchSpy = upstreamReturns('{"status":1}', { headers: { 'content-type': 'application/json' } });
    const gzipBody = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);

    const res = await request(createApp())
      .post('/api/ux/e/?compression=gzip-js&ver=1.438.3')
      .set('Content-Type', 'text/plain')
      .set('Cookie', 'alto_session=secret-session')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.7')
      .send(gzipBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${POSTHOG_INGEST}/e/?compression=gzip-js&ver=1.438.3`);
    expect(init?.method).toBe('POST');
    expect(Buffer.compare(init?.body as Buffer, gzipBody)).toBe(0);
    const sent = Object.keys(init?.headers as Record<string, string>);
    expect(sent).toContain('content-type');
    expect(sent).not.toContain('cookie');
    expect(sent).not.toContain('authorization');
    expect(sent).not.toContain('x-forwarded-for');
  });

  it('fetches project settings from the assets host and passes its caching through', async () => {
    const fetchSpy = upstreamReturns('{"sessionRecording":{}}', {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'content-encoding': 'br' },
    });

    const res = await request(createApp()).get('/api/ux/array/phc_test/config');

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${POSTHOG_ASSETS}/array/phc_test/config`);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    // fetch decoded the body already; the upstream's encoding must not be echoed.
    expect(res.headers['content-encoding']).not.toBe('br');
  });

  it('answers 502 when PostHog is unreachable, and 405 for anything but GET and POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const app = createApp();

    expect((await request(app).post('/api/ux/e/').send('x')).status).toBe(502);
    expect((await request(app).delete('/api/ux/e/')).status).toBe(405);
  });

  it('only ever targets the two PostHog hosts', () => {
    expect(relayTarget('/flags/?v=2')).toBe(`${POSTHOG_INGEST}/flags/?v=2`);
    expect(relayTarget('/static/recorder.js')).toBe(`${POSTHOG_ASSETS}/static/recorder.js`);
    expect(relayTarget('//evil.example/x')).toBeNull();
    expect(relayTarget('@evil.example/x')).toBeNull();
    expect(new URL(relayTarget('/..//evil.example/x')!).origin).toBe(POSTHOG_INGEST);
  });
});
