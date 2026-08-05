import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from './error.js';
import { logger } from '../lib/logger.js';

/**
 * Optional Idempotency-Key support for mutating endpoints.
 *
 * Contract (Stripe-style): a client that may retry a POST (mobile on a
 * flaky connection, a partner script with network-level retries) sends
 * `Idempotency-Key: <any string ≤200 chars>`. The first request executes
 * normally and its JSON response is remembered for 24h; a retry with the
 * same key on the same route by the same user replays the remembered
 * response verbatim (marked `Idempotency-Replayed: true`) instead of
 * re-executing the mutation. Reusing a key with a DIFFERENT body is a
 * client bug and answers 409, as does retrying while the original is
 * still in flight.
 *
 * Scope notes:
 * - Keyed per (user, method, concrete path, key) — two users can't
 *   collide, and the same key on two different runs' finalize routes
 *   (different :id) is two keys.
 * - The header is OPT-IN per request and the middleware is applied
 *   per-route (money movement + bulk sends), not globally: remembering
 *   every response of a 500-route CRUD API would be all cost, no win.
 *   To protect another route, add `idempotent` in front of its handler.
 * - 5xx responses are NOT remembered — the row is released so the
 *   client's retry re-executes. That matches the header's purpose:
 *   protect against double-EXECUTION, not cache failures.
 * - Storage is the DB (not process memory) so it holds across restarts
 *   and replicas.
 */

const KEY_HEADER = 'idempotency-key';
const TTL_MS = 24 * 60 * 60 * 1000;
/** Responses bigger than this aren't remembered (row released; a retry
 *  re-executes). No legitimate JSON response on the protected routes
 *  approaches this. */
const MAX_BODY_BYTES = 256 * 1024;

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

export async function idempotent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const key = req.get(KEY_HEADER)?.trim();
    if (!key) {
      next();
      return;
    }
    const user = req.user;
    if (!user) {
      // Applied routes all sit behind attachUser; a keyed request with no
      // user would mean the route is misconfigured — fail loud, not open.
      throw new HttpError(401, 'unauthorized', 'Authentication required.');
    }
    if (key.length > 200) {
      throw new HttpError(
        400,
        'invalid_idempotency_key',
        'Idempotency-Key must be at most 200 characters.',
      );
    }

    const where = {
      userId_method_path_key: {
        userId: user.id,
        method: req.method,
        path: req.baseUrl + req.path,
        key,
      },
    } as const;
    const requestHash = hashBody(req.body);

    const existing = await prisma.idempotencyRecord.findUnique({ where });
    if (existing) {
      if (existing.createdAt.getTime() < Date.now() - TTL_MS) {
        // Expired — release and fall through to a fresh execution.
        await prisma.idempotencyRecord.delete({ where }).catch(() => {});
      } else if (existing.requestHash !== requestHash) {
        throw new HttpError(
          409,
          'idempotency_key_reused',
          'This Idempotency-Key was already used with a different request body.',
        );
      } else if (existing.responseStatus === null) {
        throw new HttpError(
          409,
          'idempotency_in_progress',
          'The original request with this Idempotency-Key is still processing. Retry shortly.',
        );
      } else {
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(existing.responseStatus);
        if (existing.responseBody === null) {
          res.end();
        } else {
          res.json(existing.responseBody);
        }
        return;
      }
    }

    // Claim the key before executing. A concurrent duplicate loses the
    // unique race and is told the original is in flight.
    try {
      await prisma.idempotencyRecord.create({
        data: {
          userId: user.id,
          method: req.method,
          path: req.baseUrl + req.path,
          key,
          requestHash,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new HttpError(
          409,
          'idempotency_in_progress',
          'The original request with this Idempotency-Key is still processing. Retry shortly.',
        );
      }
      throw err;
    }

    // Capture the JSON body on its way out; persist (or release) once
    // the response is finished so the stored row always reflects what
    // the client actually received.
    let capturedBody: unknown;
    let bodyCaptured = false;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      capturedBody = body;
      bodyCaptured = true;
      return originalJson(body);
    }) as Response['json'];

    res.on('finish', () => {
      void (async () => {
        try {
          const status = res.statusCode;
          const tooBig =
            bodyCaptured &&
            Buffer.byteLength(JSON.stringify(capturedBody ?? null)) >
              MAX_BODY_BYTES;
          // updateMany/deleteMany so a row the TTL sweep (or a test
          // truncation) already removed is a no-op, not a thrown error.
          if (status >= 500 || tooBig) {
            await prisma.idempotencyRecord.deleteMany({
              where: where.userId_method_path_key,
            });
            return;
          }
          await prisma.idempotencyRecord.updateMany({
            where: where.userId_method_path_key,
            data: {
              responseStatus: status,
              responseBody: bodyCaptured
                ? ((capturedBody ?? Prisma.JsonNull) as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            },
          });
        } catch (err) {
          // Never let bookkeeping break the request that already went
          // out; the worst case is an in-flight row that expires in 24h.
          logger.warn({ err }, 'idempotency: failed to persist response');
        }
      })();
    });

    next();
  } catch (err) {
    next(err);
  }
}

/** Hourly sweep of expired rows (double the TTL for slack). */
export function startIdempotencyCleanupCron(): void {
  const HOURLY = 60 * 60 * 1000;
  const timer = setInterval(() => {
    void prisma.idempotencyRecord
      .deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 2 * TTL_MS) } },
      })
      .catch((err) => logger.warn({ err }, 'idempotency sweep failed'));
  }, HOURLY);
  timer.unref();
}
