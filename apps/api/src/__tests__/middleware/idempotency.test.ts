import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { idempotent } from '../../middleware/idempotency.js';
import { errorHandler } from '../../middleware/error.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Exercises the middleware against the real IdempotencyRecord table via
 * a scratch app (fabricated req.user), which keeps the test independent
 * of any one protected route's seeding requirements. The route
 * applications themselves are one-line wire-ups.
 */

let executions = 0;

function scratchApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: userId } as Request['user'];
    next();
  });
  app.post('/pay/runs', idempotent, (req: Request, res: Response) => {
    executions += 1;
    res.status(201).json({ runId: `run-${executions}`, echo: req.body.amount });
  });
  app.post('/pay/failing', idempotent, (_req: Request, res: Response) => {
    executions += 1;
    res.status(500).json({ error: { code: 'boom', message: 'boom' } });
  });
  app.use(errorHandler);
  return app;
}

let userId: string;

beforeEach(async () => {
  await truncateAll();
  executions = 0;
  ({ user: { id: userId } } = await createUser({ role: 'HR_ADMINISTRATOR' }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Wait for the res.on('finish') persistence hook to land. */
async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

describe('idempotent middleware', () => {
  it('executes normally without the header', async () => {
    const app = scratchApp(userId);
    const a = await request(app).post('/pay/runs').send({ amount: 1 });
    const b = await request(app).post('/pay/runs').send({ amount: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(executions).toBe(2);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it('replays the stored response for a same-key same-body retry', async () => {
    const app = scratchApp(userId);
    const first = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-1')
      .send({ amount: 100 });
    expect(first.status).toBe(201);
    await settled();

    const retry = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-1')
      .send({ amount: 100 });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    // The handler ran exactly once.
    expect(executions).toBe(1);
  });

  it('409s when the same key arrives with a different body', async () => {
    const app = scratchApp(userId);
    await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-2')
      .send({ amount: 100 });
    await settled();

    const clash = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-2')
      .send({ amount: 999 });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('idempotency_key_reused');
    expect(executions).toBe(1);
  });

  it('scopes keys per user and per path', async () => {
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const appA = scratchApp(userId);
    const appB = scratchApp(other.id);

    await request(appA).post('/pay/runs').set('Idempotency-Key', 'k-3').send({ amount: 1 });
    await settled();
    const otherUser = await request(appB)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-3')
      .send({ amount: 1 });
    expect(otherUser.status).toBe(201);
    expect(otherUser.headers['idempotency-replayed']).toBeUndefined();
    expect(executions).toBe(2);
  });

  it('409s in-progress while the original has not finished', async () => {
    // Simulate an in-flight original: a claimed row with no response yet.
    await prisma.idempotencyRecord.create({
      data: {
        userId,
        method: 'POST',
        path: '/pay/runs',
        key: 'k-4',
        // Matches hashBody({amount: 5}) — recompute the same way.
        requestHash: (await import('node:crypto'))
          .createHash('sha256')
          .update(JSON.stringify({ amount: 5 }))
          .digest('hex'),
      },
    });
    const app = scratchApp(userId);
    const res = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-4')
      .send({ amount: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('idempotency_in_progress');
    expect(executions).toBe(0);
  });

  it('releases the key on a 5xx so the retry re-executes', async () => {
    const app = scratchApp(userId);
    const first = await request(app)
      .post('/pay/failing')
      .set('Idempotency-Key', 'k-5')
      .send({ amount: 1 });
    expect(first.status).toBe(500);
    await settled();
    expect(await prisma.idempotencyRecord.count()).toBe(0);

    const retry = await request(app)
      .post('/pay/failing')
      .set('Idempotency-Key', 'k-5')
      .send({ amount: 1 });
    expect(retry.status).toBe(500);
    expect(executions).toBe(2);
  });

  it('expired rows fall through to fresh execution', async () => {
    const app = scratchApp(userId);
    await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-6')
      .send({ amount: 1 });
    await settled();
    await prisma.idempotencyRecord.updateMany({
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const later = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'k-6')
      .send({ amount: 1 });
    expect(later.status).toBe(201);
    expect(later.headers['idempotency-replayed']).toBeUndefined();
    expect(executions).toBe(2);
  });

  it('rejects oversized keys', async () => {
    const app = scratchApp(userId);
    const res = await request(app)
      .post('/pay/runs')
      .set('Idempotency-Key', 'x'.repeat(201))
      .send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
    expect(executions).toBe(0);
  });
});
