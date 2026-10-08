import type { Request } from 'express';
import express from 'express';
import * as Sentry from '@sentry/node';

/**
 * The parameterized name of the route a request matched — "GET /api/time/
 * me/earnings", not "GET" and not "GET /api/time/me/earnings?x" — for
 * Sentry's transaction name.
 *
 * Express sets `req.route` when a Route dispatches, and at that moment
 * `req.baseUrl` is the mount path of the router it lives in. Both are gone
 * by the time the response finishes (Express restores baseUrl as each
 * router unwinds), so the name is taken right there, in Route.dispatch,
 * and written onto the request's root span. That also covers a handler
 * that throws: the route had matched, the name is already set, and the
 * error response keeps it.
 *
 * Independent of Sentry's own Express instrumentation: with the ESM
 * `--import` hook that instrumentation names spans too, and this simply
 * overwrites with the same shape plus the /api prefix riders actually hit.
 */

type RouteProto = { prototype: { dispatch: (this: { path?: string }, req: Request, ...rest: unknown[]) => unknown } };

const NAMED = new WeakSet<Request>();
let installed = false;

export function fullRoutePattern(req: Request): string | null {
  const stamped = (req as Request & { altoRoutePattern?: string }).altoRoutePattern;
  if (stamped) return stamped;
  const route = (req as Request & { route?: { path?: string } }).route;
  if (!route?.path) return null;
  return `${req.baseUrl || ''}${route.path === '/' ? '' : route.path}` || '/';
}

function nameSpan(req: Request, pattern: string): void {
  if (NAMED.has(req)) return;
  NAMED.add(req);
  const span = Sentry.getActiveSpan();
  if (!span) return;
  const prefix = req.originalUrl.startsWith('/api/') || req.originalUrl === '/api' ? '/api' : '';
  const root = Sentry.getRootSpan(span);
  Sentry.updateSpanName(root, `${req.method} ${prefix}${pattern}`);
  root.setAttribute('http.route', `${prefix}${pattern}`);
}

/** Patch once, before the app is built; safe to call again. */
export function installRouteNaming(): void {
  if (installed) return;
  installed = true;
  const Route = (express as unknown as { Route: RouteProto }).Route;
  const original = Route.prototype.dispatch;
  Route.prototype.dispatch = function dispatch(this: { path?: string }, req: Request, ...rest: unknown[]) {
    try {
      const path = this.path ?? '';
      const pattern = `${req.baseUrl || ''}${path === '/' ? '' : path}` || '/';
      (req as Request & { altoRoutePattern?: string }).altoRoutePattern = pattern;
      nameSpan(req, pattern);
    } catch {
      // Naming a span must never be the reason a request fails.
    }
    return original.call(this, req, ...rest);
  };
}
