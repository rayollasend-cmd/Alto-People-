import { env } from './config/env.js';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { startKeepAlive } from './lib/keepalive.js';

const app = createApp();

app.listen(env.PORT, async () => {
  console.log(`[alto-people/api] listening on http://localhost:${env.PORT}`);
  console.log(`[alto-people/api] CORS origin: ${env.CORS_ORIGIN}`);

  // Wake the DB pool immediately so the first user request doesn't pay the
  // cold-start. Best-effort — if the DB is unreachable, we still serve
  // /health and the routes will surface their own errors.
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    console.log(`[alto-people/api] DB warm (${Date.now() - t0}ms)`);
  } catch (err) {
    console.warn(
      '[alto-people/api] DB warm-up failed:',
      err instanceof Error ? err.message : err
    );
  }

  if (env.KEEP_ALIVE_INTERVAL_SECONDS > 0) {
    startKeepAlive(env.KEEP_ALIVE_INTERVAL_SECONDS);
    console.log(
      `[alto-people/api] DB keep-alive every ${env.KEEP_ALIVE_INTERVAL_SECONDS}s ` +
        '(uses Neon compute hours; set KEEP_ALIVE_INTERVAL_SECONDS=0 to disable)'
    );
  }
});
