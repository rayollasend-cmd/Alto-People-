import { PrismaClient } from '@prisma/client';

// Singleton across `tsx watch` reloads — without this, dev mode opens a new
// Prisma connection pool on every file change and exhausts Postgres slots.
declare global {
  // eslint-disable-next-line no-var
  var __altoPrisma__: PrismaClient | undefined;
}

function makeClient(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  // Retry transient "Can't reach database" errors. Neon's serverless Postgres
  // auto-suspends after idle and takes a moment to wake — the first query
  // after a cold window can fail with P1001 before the compute is ready.
  // Three attempts (0 / 800 / 2000 ms) ride out the typical wake latency
  // without masking a genuine outage: a real outage exhausts all three and
  // still surfaces to Sentry. A console.warn on first retry leaves a
  // breadcrumb so cold-start frequency stays observable in logs.
  return base.$extends({
    query: {
      $allOperations: async ({ args, query, model, operation }) => {
        const delays = [0, 800, 2000];
        let lastErr: unknown;
        for (let i = 0; i < delays.length; i++) {
          const d = delays[i];
          if (d > 0) await new Promise((r) => setTimeout(r, d));
          try {
            return await query(args);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/P1001|Can't reach database server|connection/i.test(msg)) throw err;
            lastErr = err;
            if (i === 0 && process.env.NODE_ENV !== 'test') {
              console.warn(
                `[db] transient connect failure on ${model ?? '?'}.${operation}; retrying`,
              );
            }
          }
        }
        throw lastErr;
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalThis.__altoPrisma__ ?? makeClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__altoPrisma__ = prisma;
}
