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

  // Retry transient "Can't reach database" errors only in test mode. Neon's
  // serverless Postgres goes idle quickly; the production app should surface
  // P1001 to its monitoring rather than mask it.
  if (process.env.NODE_ENV !== 'test') return base;

  return base.$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        const delays = [0, 800, 2000];
        let lastErr: unknown;
        for (const d of delays) {
          if (d > 0) await new Promise((r) => setTimeout(r, d));
          try {
            return await query(args);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/P1001|Can't reach database server|connection/i.test(msg)) throw err;
            lastErr = err;
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
