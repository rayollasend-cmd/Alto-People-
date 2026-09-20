import { describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * Guards the fix in `test/setup.ts` for the suite's long-running socket
 * flakes. supertest binds a fresh ephemeral server per request and closes
 * it; with a keep-alive agent every closed server leaves a dead socket
 * pooled against its port, and once the OS recycles that port a later
 * request goes out on a socket to a server that no longer exists —
 * surfacing as ECONNRESET, a hang, or a bodiless 400 from Node's own
 * clientError handler.
 *
 * Nothing in the suite fails loudly if this regresses. It just gets flaky
 * again, in a different file every run, which is the hardest kind of
 * failure to attribute — so assert it directly.
 */
describe('the test HTTP agents never pool sockets', () => {
  it('is configured for connection-per-request', () => {
    expect(http.globalAgent.keepAlive).toBe(false);
    expect(https.globalAgent.keepAlive).toBe(false);
  });

  it('leaves nothing pooled after a burst of requests', async () => {
    for (let i = 0; i < 25; i++) {
      await request(createApp())
        .post('/auth/login')
        .send({ email: `no-such-user-${i}@example.com`, password: 'wrong-password-padding' });
    }
    // A pooled entry here is a socket outliving the server it belongs to.
    expect(Object.keys(http.globalAgent.freeSockets)).toHaveLength(0);
  });

  it('survives a server reusing a just-freed port — the actual failure', async () => {
    const serve = (port: number) =>
      new Promise<http.Server>((resolve) => {
        const s = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
    const get = (port: number) =>
      new Promise<number | string>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode ?? 0));
        });
        req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERR'));
        req.end();
      });

    const first = await serve(0);
    const port = (first.address() as { port: number }).port;
    expect(await get(port)).toBe(200);
    await new Promise((r) => first.close(r));

    // Same port, different server — with keep-alive on, this is the
    // ECONNRESET that has been failing a random file every full run.
    const second = await serve(port);
    expect(await get(port)).toBe(200);
    await new Promise((r) => second.close(r));
  });
});
