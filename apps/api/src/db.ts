import { PrismaClient } from '@prisma/client';
import { guardTenantQuery } from './lib/tenantGuard.js';

// Singleton across `tsx watch` reloads — without this, dev mode opens a new
// Prisma connection pool on every file change and exhausts Postgres slots.
declare global {
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
  // Brief 1D-1: a shift carries its Worker. Every write that sets
  // assignedAssociateId — assign, unassign, pickup approvals, swaps, bulk
  // creates, publishes — also sets workerId to that associate's PERSON
  // worker, or clears it, without any call site knowing. A write that sets
  // workerId itself (an agent or a robot) is left alone.
  const workerIdFor = async (associateId: string | null | undefined): Promise<string | null | undefined> => {
    if (associateId === undefined) return undefined;
    if (associateId === null) return null;
    const w = await base.worker.findUnique({ where: { associateId }, select: { id: true } });
    return w?.id ?? null;
  };
  const syncShiftData = async (data: Record<string, unknown> | undefined): Promise<void> => {
    if (!data || typeof data !== 'object' || 'workerId' in data) return;
    if (!('assignedAssociateId' in data)) return;
    const raw = data.assignedAssociateId;
    // Prisma accepts `{ set: value }` as well as a bare value.
    const value = raw && typeof raw === 'object' && 'set' in (raw as object) ? (raw as { set: string | null }).set : (raw as string | null | undefined);
    const workerId = await workerIdFor(value);
    if (workerId !== undefined) data.workerId = workerId;
  };

  return base.$extends({
    query: {
      shift: {
        async create({ args, query }) {
          await syncShiftData(args.data as Record<string, unknown>);
          return query(args);
        },
        async createMany({ args, query }) {
          const rows = Array.isArray(args.data) ? args.data : [args.data];
          for (const row of rows) await syncShiftData(row as Record<string, unknown>);
          return query(args);
        },
        async update({ args, query }) {
          await syncShiftData(args.data as Record<string, unknown>);
          return query(args);
        },
        async updateMany({ args, query }) {
          await syncShiftData(args.data as Record<string, unknown>);
          return query(args);
        },
        async upsert({ args, query }) {
          await syncShiftData(args.create as Record<string, unknown>);
          await syncShiftData(args.update as Record<string, unknown>);
          return query(args);
        },
      },
      $allOperations: async ({ args, query, model, operation }) => {
        // Brief 2-1, step two: the tenant wall in observe mode (lib/tenantGuard).
        args = guardTenantQuery(model, operation, args) as typeof args;
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
