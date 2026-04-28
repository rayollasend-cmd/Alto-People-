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

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'not_found', message: 'Route not found' },
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
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
      },
    });
    return;
  }

  console.error('[alto-people/api] unhandled error:', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
}
