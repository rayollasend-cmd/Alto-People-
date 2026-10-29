import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { z, ZodError } from 'zod';

const captured = vi.hoisted(() => ({ calls: [] as Array<{ err: unknown; ctx: Record<string, unknown> | undefined }> }));
vi.mock('../../lib/sentry.js', () => ({
  captureException: (err: unknown, ctx?: Record<string, unknown>) => {
    captured.calls.push({ err, ctx });
  },
}));

const { errorHandler, zodErrorSource } = await import('../../middleware/error.js');
const { logger } = await import('../../lib/logger.js');

/**
 * CRAWL-6 (deep audit 2026-10-29): every ZodError used to become
 * "400 Invalid request body" — including the API's own RESPONSE parse
 * failures (CRAWL-1's org-wide cost-center list), which were then neither
 * logged nor reported. A request the client got wrong stays a 400 with its
 * fields; a parse of something the server built is a 500, logged and
 * reported with the route and the offending field, and the user reads
 * "Something went wrong on our side."
 */

const CreateSchema = z.object({ name: z.string().min(1), items: z.array(z.object({ qty: z.number() })).optional() });
const CostCenterSchema = z.object({ id: z.string(), clientId: z.uuid() });
const CostCenterListResponseSchema = z.object({ costCenters: z.array(CostCenterSchema) });
const TotalsSchema = z.object({ total: z.number() });

function app() {
  const a = express();
  a.use(express.json());
  a.post('/things', (req: Request, res: Response) => {
    const body = CreateSchema.parse(req.body);
    res.status(201).json(body);
  });
  a.post('/things/via-variable', (req: Request, res: Response) => {
    const input: unknown = req.body;
    const body = CreateSchema.parse(input);
    res.json(body);
  });
  a.post('/things/echo', (req: Request, res: Response) => {
    const input: unknown = req.body;
    res.json(CreateSchema.parse(input));
  });
  a.post('/things/form', (req: Request, res: Response) => {
    const body = CreateSchema.parse(JSON.parse(String(req.body.payload)));
    res.json(body);
  });
  a.get('/cost-centers', (_req: Request, res: Response) => {
    const costCenters = [{ id: 'cc-1', clientId: '' }];
    const body = CostCenterListResponseSchema.parse({ costCenters });
    res.json(body);
  });
  a.get('/totals', (_req: Request, res: Response) => {
    const total = 'twelve' as unknown as number;
    res.json(TotalsSchema.parse({ total }));
  });
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  captured.calls.length = 0;
});

describe('a ZodError from the request', () => {
  it('stays a 400 with the field details', async () => {
    const res = await request(app()).post('/things').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(res.body.error.details.fieldErrors).toHaveProperty('name');
    expect(captured.calls).toHaveLength(0);
  });

  it('is a 400 for a nested field the client sent wrong', async () => {
    const res = await request(app()).post('/things').send({ name: 'x', items: [{ qty: 'one' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('is a 400 when the body reached the schema through a variable', async () => {
    const res = await request(app()).post('/things/via-variable').send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors).toHaveProperty('name');
  });

  it('is a 400 when a variable holding the body is parsed inside res.json()', async () => {
    const res = await request(app()).post('/things/echo').send({});
    expect(res.status).toBe(400);
  });

  it('is a 400 when the route parsed a JSON field of the body', async () => {
    const res = await request(app()).post('/things/form').send({ payload: JSON.stringify({ name: 'x', items: [{ qty: 'one' }] }) });
    expect(res.status).toBe(400);
  });
});

describe('a ZodError from the server’s own answer', () => {
  it('is a 500, logged and reported with the route and the field, and says nothing about the request', async () => {
    const spy = vi.spyOn(logger, 'error');
    const res = await request(app()).get('/cost-centers');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(res.body.error.message).toBe('Something went wrong on our side.');
    expect(res.body.error.details).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('clientId');
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]!.err).toBeInstanceOf(ZodError);
    expect(captured.calls[0]!.ctx).toMatchObject({ kind: 'response_schema', route: 'GET /cost-centers', fields: ['costCenters.0.clientId'] });
    const logged = spy.mock.calls.find((c) => c[1] === 'response failed its own schema');
    expect(logged?.[0]).toMatchObject({ route: 'GET /cost-centers', fields: ['costCenters.0.clientId'] });
    spy.mockRestore();
  });

  it('is a 500 for a top-level field parsed inside res.json()', async () => {
    const res = await request(app()).get('/totals');
    expect(res.status).toBe(500);
    expect(captured.calls[0]!.ctx).toMatchObject({ fields: ['total'] });
  });
});

describe('zodErrorSource without a readable call site (shape only)', () => {
  function stripped(fn: () => unknown): ZodError {
    try {
      fn();
    } catch (e) {
      (e as Error).stack = '';
      return e as ZodError;
    }
    throw new Error('expected a ZodError');
  }

  it('a missing field whose parent object is in the body is the request’s', () => {
    const body = {};
    const err = stripped(() => CreateSchema.parse(body));
    expect(zodErrorSource(err, { body, query: {}, params: {} } as never)).toBe('request');
  });

  it('a field the request has no parent for is the server’s', () => {
    const err = stripped(() => CostCenterListResponseSchema.parse({ costCenters: [{ id: 'a', clientId: '' }] }));
    expect(zodErrorSource(err, { body: undefined, query: {}, params: {} } as never)).toBe('server');
  });
});
