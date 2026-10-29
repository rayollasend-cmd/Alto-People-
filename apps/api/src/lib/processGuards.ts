import { logger } from './logger.js';

/**
 * A promise nobody caught must never take the API down (audit 2026-10-29,
 * CODE-22). Since Node 15 an unhandled rejection exits the process unless a
 * handler is installed; with Sentry's DSN set its own handler kept the
 * process up, so dev and CI (no DSN) were the places a stray rejected
 * notification killed the server. This handler logs the reason and the
 * process stays up; Sentry, when configured, still records it through its
 * own integration.
 */
let installed = false;

export function onUnhandledRejection(reason: unknown): void {
  let err: Error;
  if (reason instanceof Error) err = reason;
  else {
    let text: string;
    try {
      text = typeof reason === 'string' ? reason : JSON.stringify(reason ?? null);
    } catch {
      text = String(reason);
    }
    err = new Error(text);
  }
  logger.error({ err, where: 'unhandledRejection' }, 'unhandled promise rejection (process kept running)');
}

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', onUnhandledRejection);
}
