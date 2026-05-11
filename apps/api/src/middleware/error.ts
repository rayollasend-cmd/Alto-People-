import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

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

  console.error(`[alto-people/api] [${requestId}] unhandled error:`, err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error', requestId },
  });
}
