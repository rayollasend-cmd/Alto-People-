import { PrismaClient } from '@prisma/client';

// Singleton across `tsx watch` reloads — without this, dev mode opens a new
// Prisma connection pool on every file change and exhausts Postgres slots.
declare global {
  // eslint-disable-next-line no-var
  var __altoPrisma__: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__altoPrisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__altoPrisma__ = prisma;
}
