import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import { ZodError } from 'zod';
import { captureException } from '../lib/sentry.js';
import { logger } from '../lib/logger.js';
import {
  htmlErrorCopy,
  htmlErrorPage,
  isBrowserNavigation,
} from '../lib/browserNavigation.js';

// Errors owe the client its own dialect: API callers (fetch/XHR,
// integrations, pollers) get the JSON envelope they parse, but a browser
// PAGE LOAD that errors — an expired paystub link, a 404 on a document
// download, a dead calendar URL — must never render raw JSON on screen.
// Those get a small branded HTML page instead. (Page paths themselves
// never reach here on a navigation — app.ts serves the SPA shell first —
// so this only fires for the file-download URLs that are exempt from the
// shell, plus any future gap. Belt to app.ts's suspenders.)
function sendError(
  req: Request,
  res: Response,
  status: number,
  body: { code: string; message: string; details?: unknown },
): void {
  if (isBrowserNavigation(req)) {
    res
      .status(status)
      .type('html')
      .send(htmlErrorPage({ status, ...htmlErrorCopy(status), requestId: req.id }));
    return;
  }
  res.status(status).json({ error: { ...body, requestId: req.id } });
}

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
  sendError(req, res, 404, { code: 'not_found', message: 'Route not found' });
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

  // Streaming routes (ZIP/PDF downloads) can fail AFTER headers are sent.
  // Attempting res.status().json() then throws "Cannot set headers after
  // they are sent" INSIDE this handler, and the half-written response is
  // left open forever — the browser sits on a download that never
  // finishes. Destroy the socket instead: the client's fetch rejects
  // immediately and the UI can show a real error.
  if (res.headersSent) {
    const e = err instanceof Error ? err : new Error(String(err));
    (req.log ?? logger).error(
      { err: e.message, requestId },
      'error after headers sent — destroying streamed response',
    );
    captureException(e);
    res.destroy(e);
    return;
  }

  if (err instanceof HttpError) {
    sendError(req, res, err.status, {
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Routes that call `Schema.parse(req.body)` directly (rather than
  // safeParse + manual HttpError) bubble a ZodError up here. Translate
  // those into a clean 400 with the field-level details, so clients
  // get something actionable instead of a generic 500.
  if (err instanceof ZodError) {
    sendError(req, res, 400, {
      code: 'invalid_body',
      message: 'Invalid request body',
      details: err.flatten(),
    });
    return;
  }

  // Multer rejects oversized / malformed uploads by throwing its own
  // error class, which is neither HttpError nor ZodError — so a phone
  // photo over the 10 MB cap was answered with "500 internal_error" and
  // paged Sentry, on all five upload routes. These are client errors
  // with actionable messages.
  if (err instanceof MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const code =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'file_too_large'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'too_many_files'
          : 'invalid_upload';
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`
        : 'That upload could not be read. Try a different file.';
    sendError(req, res, status, { code, message });
    return;
  }

  // Prisma's "you asked for something that isn't there" family are
  // client errors, not server faults: P2023 = malformed id (e.g. a
  // non-UUID in a :id param reaching a UUID column), P2025 = record not
  // found on update/delete. Both used to fall through to 500
  // internal_error AND page Sentry — a double-clicked "Revoke" button
  // filed an incident.
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2023' || err.code === 'P2025')
  ) {
    if (err.code === 'P2025') {
      sendError(req, res, 404, { code: 'not_found', message: 'Record not found.' });
    } else {
      sendError(req, res, 400, { code: 'invalid_id', message: 'Malformed identifier.' });
    }
    return;
  }

  // A malformed JSON body reaches here as a SyntaxError from
  // express.json(). That's the client's mistake, not a server fault.
  if (
    err instanceof SyntaxError &&
    'body' in (err as SyntaxError & { body?: unknown })
  ) {
    sendError(req, res, 400, {
      code: 'invalid_json',
      message: 'Request body is not valid JSON.',
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
  sendError(req, res, 500, { code: 'internal_error', message: 'Internal server error' });
}
