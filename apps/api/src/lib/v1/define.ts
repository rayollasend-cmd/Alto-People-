import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { API_SCOPES, API_SCOPE_LABELS, type ApiScope } from '@alto-people/shared';
import { HttpError } from '../../middleware/error.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requireApiToken } from '../../middleware/apiToken.js';

/**
 * Brief 2-4 step 2 — every /v1 route is declared once.
 *
 *   defineRoute mounts the Express handler (token, scopes, rate limits,
 *   idempotency on POST, validation of params, query and body) AND registers
 *   the operation in the OpenAPI registry, so the spec at /v1/openapi.json is
 *   generated from the same declaration and cannot drift (a test compares
 *   the router with the spec both ways).
 *
 *   The response is parsed through its public schema on the way out: zod
 *   strips every field the schema does not name, so an internal field can
 *   never ride along by accident (§5.3 of the report, enforced, not hoped).
 */

extendZodWithOpenApi(z);

export const v1Registry = new OpenAPIRegistry();

v1Registry.registerComponent('securitySchemes', 'oauth2', {
  type: 'oauth2',
  description: 'OAuth 2 client credentials. Trade the client id and secret at /v1/oauth/token for a 15-minute bearer token.',
  flows: { clientCredentials: { tokenUrl: '/api/v1/oauth/token', scopes: Object.fromEntries(API_SCOPES.map((s) => [s, API_SCOPE_LABELS[s]])) } },
});

export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }) });

const isTest = process.env.NODE_ENV === 'test';
/** 600 requests a minute per client (owner's decision 11). */
const clientLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 100_000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => `v1:client:${req.apiClient?.id ?? 'none'}`,
  message: { error: { code: 'rate_limited', message: 'Too many requests for this client. Try again in a minute.' } },
});
/** 3,000 a minute per tenant across all its clients. */
const tenantLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 100_000 : 3_000,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `v1:tenant:${req.apiClient?.tenantId ?? 'none'}`,
  message: { error: { code: 'rate_limited', message: 'Too many requests for this organization. Try again in a minute.' } },
});

/** Every /v1 POST names its Idempotency-Key (owner's decision 10). */
const requireIdempotencyKey: RequestHandler = (req, _res, next) => {
  if (!req.get('Idempotency-Key')?.trim()) throw new HttpError(400, 'idempotency_key_required', 'Every POST to /v1 needs an Idempotency-Key header.');
  next();
};

export type V1Method = 'get' | 'post' | 'patch' | 'delete';

export interface V1Context<P, Q, B> {
  req: Request;
  params: P;
  query: Q;
  body: B;
}

export interface V1RouteSpec<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  method: V1Method;
  /** Express style, relative to /v1: '/workers/:id'. */
  path: string;
  /** null: no token (the token endpoint and the spec). */
  scopes: readonly ApiScope[] | null;
  tag: string;
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  /** The public shape; null for 204. */
  response: R | null;
  status?: 200 | 201 | 202 | 204;
  /** Extra middleware before the handler (form parsing on the token endpoint). */
  before?: RequestHandler[];
  handler: (ctx: V1Context<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<z.infer<R> | void>;
}

/** Every declared route, for the route-match test. */
export const declaredV1Routes: Array<{ method: V1Method; path: string }> = [];

const openApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

export function defineRoute<P extends z.ZodTypeAny = z.ZodTypeAny, Q extends z.ZodTypeAny = z.ZodTypeAny, B extends z.ZodTypeAny = z.ZodTypeAny, R extends z.ZodTypeAny = z.ZodTypeAny>(
  router: Router,
  spec: V1RouteSpec<P, Q, B, R>,
): void {
  const status = spec.status ?? (spec.method === 'post' ? 201 : 200);
  const chain: RequestHandler[] = [];
  if (spec.scopes) chain.push(requireApiToken(spec.scopes), clientLimiter, tenantLimiter);
  if (spec.method === 'post' && spec.scopes) chain.push(requireIdempotencyKey, idempotent);
  chain.push(...(spec.before ?? []));
  chain.push(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = spec.params ? spec.params.parse(req.params) : req.params;
      const query = spec.query ? spec.query.parse(req.query) : req.query;
      const body = spec.body ? spec.body.parse(req.body ?? {}) : undefined;
      const out = await spec.handler({ req, params, query, body } as V1Context<z.infer<P>, z.infer<Q>, z.infer<B>>);
      if (status === 204 || !spec.response) {
        res.status(204).end();
        return;
      }
      res.status(status).json(spec.response.parse(out));
    } catch (err) {
      next(err);
    }
  });
  router[spec.method](spec.path, ...chain);
  declaredV1Routes.push({ method: spec.method, path: spec.path });

  const responses: Record<string, unknown> = {
    [status]: spec.response
      ? { description: 'OK', content: { 'application/json': { schema: spec.response } } }
      : { description: 'No content' },
    400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorSchema } } },
  };
  if (spec.scopes) {
    responses[401] = { description: 'Missing, invalid or expired token', content: { 'application/json': { schema: ErrorSchema } } };
    responses[403] = { description: 'The client lacks a scope', content: { 'application/json': { schema: ErrorSchema } } };
    responses[429] = { description: 'Rate limited', content: { 'application/json': { schema: ErrorSchema } } };
  }
  if (/:[A-Za-z]/.test(spec.path)) responses[404] = { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } };
  v1Registry.registerPath({
    method: spec.method,
    path: openApiPath(spec.path),
    tags: [spec.tag],
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.scopes ? { security: [{ oauth2: [...spec.scopes] }] } : { security: [] }),
    request: {
      ...(spec.params ? { params: spec.params as unknown as z.AnyZodObject } : {}),
      ...(spec.query ? { query: spec.query as unknown as z.AnyZodObject } : {}),
      ...(spec.body ? { body: { content: { 'application/json': { schema: spec.body } } } } : {}),
      ...(spec.method === 'post' && spec.scopes ? { headers: z.object({ 'Idempotency-Key': z.string().max(200) }) } : {}),
    },
    responses: responses as never,
  });
}

let built: unknown = null;

/** The OpenAPI 3.1 document, generated from the registry once. */
export function v1OpenApiDocument(): unknown {
  if (!built) {
    built = new OpenApiGeneratorV31(v1Registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: {
        title: 'Alto People API',
        version: '1.0.0',
        description: 'The public API of Alto People. OAuth 2 client credentials; cursor pagination; Idempotency-Key on every POST; pay rates only under pay:read; clock-in coordinates never.',
      },
      servers: [{ url: '/api' }],
    });
  }
  return built;
}

/** Cursor pagination: ?cursor (an id) and ?limit (1–200, default 50). */
export const PageQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().uuid().nullable() });

/** Rows fetched with take: limit + 1 → the page and the next cursor. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): { rows: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  return { rows: slice, nextCursor: more ? slice[slice.length - 1]!.id : null };
}

export const IdParams = z.object({ id: z.string().uuid() });
