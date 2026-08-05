import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Process-wide structured logger.
 *
 * Emits one JSON object per log line on stdout. Railway (and any other
 * standard log aggregator) parses these natively, so a single
 * `requestId` field on the object turns "find every log for that
 * trace" into a `requestId="…"` filter instead of a grep dance.
 *
 * Shape: `{ level, time, msg, requestId?, userId?, ...context }`.
 *
 * Levels:
 *   - dev: 'debug' (verbose, pretty-printed via pino-pretty if available)
 *   - test: 'silent' (don't pollute test output)
 *   - prod: 'info'
 *
 * Production deliberately stays at JSON output — no pretty-printer.
 * The cost of structured logs is uglier dev tail; the win is that
 * production logs become searchable by any field without re-parsing.
 */
const level =
  env.NODE_ENV === 'test'
    ? 'silent'
    : env.NODE_ENV === 'production'
      ? 'info'
      : 'debug';

export const logger = pino({
  level,
  // Render error objects (`err`) with their stack + cause chain rather
  // than `{}` (Pino's default for non-enumerable Error properties).
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Strip default `pid` and `hostname` — Railway already tags those at
  // the platform layer, and they add noise to every line.
  base: { service: 'alto-people-api' },
  // Belt-and-braces redaction. Nothing deliberately logs a secret today,
  // but this app handles SSNs, bank details and kiosk PINs — a single
  // future `req.log.info({ body })` would otherwise ship them to the
  // platform log drain, where they are effectively unrecallable.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.password',
      '*.passwordHash',
      '*.ssn',
      '*.ssnEncrypted',
      '*.pin',
      '*.pinHmac',
      '*.accountNumber',
      '*.routingNumber',
      '*.deviceToken',
      '*.token',
      '*.secret',
      '*.selfie',
    ],
    censor: '[redacted]',
  },
});

/**
 * Per-request child logger. Mounted in middleware/requestId.ts so
 * route handlers can grab `req.log` and get a logger that already
 * carries `{ requestId, method, path, userId }` on every line.
 */
export type RequestLogger = pino.Logger;

export function makeRequestLogger(fields: {
  requestId: string;
  method: string;
  path: string;
  userId?: string | null;
}): RequestLogger {
  return logger.child(fields);
}
