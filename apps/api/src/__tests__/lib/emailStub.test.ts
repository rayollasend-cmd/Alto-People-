import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../test/db.js';
import { logger } from '../../lib/logger.js';
import { STUB_EMAIL_REF_PREFIX, emailConfigured, onStubbedEmail, send } from '../../lib/notifications.js';

/**
 * Audit 2026-10-29 CODE-34: with no email provider connected, the stub used to
 * print every email, magic links included, to the server log. Now only the
 * fact ("not sent") reaches the log; tests hear the message through
 * onStubbedEmail, and the stored reference marks it as never sent.
 */

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the email stub (no provider connected)', () => {
  it('logs that it was not sent, never the body or its link', async () => {
    expect(emailConfigured()).toBe(false);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'info').mockImplementation(capture);
    const info = vi.spyOn(logger, 'info').mockImplementation(capture as never);
    const heard: string[] = [];
    const stop = onStubbedEmail((e) => heard.push(e.body));
    try {
      const secretLink = 'https://app.example.test/auth/magic?token=s3cr3t-token-abcdef0123456789';
      const r = await send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: 'stub-check@example.test' },
        subject: 'Your sign-in link',
        body: `Sign in: ${secretLink}\nYour code is 482913.`,
        audit: false,
      });
      expect(r.externalRef?.startsWith(STUB_EMAIL_REF_PREFIX)).toBe(true);
      expect(heard).toEqual([`Sign in: ${secretLink}\nYour code is 482913.`]);
      expect(info).toHaveBeenCalled();
      const logged = lines.join('\n');
      expect(logged).toMatch(/not sent/);
      expect(logged).not.toContain('s3cr3t');
      expect(logged).not.toContain('482913');
      expect(logged).not.toContain('Sign in:');
    } finally {
      stop();
    }
  });
});
