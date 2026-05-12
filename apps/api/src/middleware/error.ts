import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { captureException } from '../lib/sentry.js';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'not_found', message: 'Route not found', requestId: req.id },
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // The request ID surfaces in every error body so a user (or support
  // ticket) can quote it back and ops can grep logs for the trace. Falls
  // back to undefined if the requestId middleware didn't run — defensive,
  // but should never happen in practice.
  const requestId = req.id;

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  // Routes that call `Schema.parse(req.body)` directly (rather than
  // safeParse + manual HttpError) bubble a ZodError up here. Translate
  // those into a clean 400 with the field-level details, so clients
  // get something actionable instead of a generic 500.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'invalid_body',
        message: 'Invalid request body',
        details: err.flatten(),
        requestId,
      },
    });
    return;
  }

  // Prefer the per-request logger so the line carries the same
  // requestId / method / path tags as everything else. Fall back to
  // the global logger if the requestId middleware didn't run.
  (req.log ?? logger).error(
    { err, userId: req.user?.id ?? null },
    'unhandled error',
  );
  // Report unhandled errors (not HttpError, not ZodError) to Sentry —
  // those two are expected control-flow signals, not bugs. Tag with the
  // request id + path so a single trace ties the Sentry event to logs
  // and the audit row that any in-flight handler may have written.
  captureException(err, {
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id ?? null,
  });
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error', requestId },
  });
}
