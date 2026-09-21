import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { assertBulkPiiExporter } from '../../lib/bulkPiiExport.js';
import { env } from '../../config/env.js';

/**
 * The capability answers "may this job touch SSNs". This answers "may this
 * person carry the whole roster out of the building" — the two are not the
 * same question, and the payroll census, the new-hire report, the external
 * sheet and the audit packet are all the second one.
 */

const asRequest = (email: string): Request =>
  ({
    user: { email },
    path: '/org/associates/payroll-census-export',
    headers: {},
  }) as unknown as Request;

const withAllowlist = (value: string | undefined) => {
  const previous = env.PII_BULK_EXPORT_USERS;
  (env as { PII_BULK_EXPORT_USERS?: string }).PII_BULK_EXPORT_USERS = value;
  return () => {
    (env as { PII_BULK_EXPORT_USERS?: string }).PII_BULK_EXPORT_USERS = previous;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bulk PII export', () => {
  it('lets a named person through', () => {
    const restore = withAllowlist('kpakpo@altohr.com, darison@altohr.com');
    try {
      expect(assertBulkPiiExporter(asRequest('darison@altohr.com'))).toBe('allowlist');
      // Case and spacing are how people actually type a list.
      expect(assertBulkPiiExporter(asRequest('  KPAKPO@AltoHR.com '))).toBe('allowlist');
    } finally {
      restore();
    }
  });

  it('refuses everyone else, capability or not', () => {
    const restore = withAllowlist('kpakpo@altohr.com');
    try {
      expect(() => assertBulkPiiExporter(asRequest('someone.else@altohr.com'))).toThrow(
        /named people/i,
      );
      expect(() => assertBulkPiiExporter(asRequest(''))).toThrow(/named people/i);
    } finally {
      restore();
    }
  });

  it('falls back to the capability when nobody is named, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = withAllowlist(undefined);
    try {
      // A blank env var on a deploy must not be able to stop payday — but
      // the export is marked so it can never read as an approved one.
      expect(assertBulkPiiExporter(asRequest('anyone@altohr.com'))).toBe('unset');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('PII_BULK_EXPORT_USERS is not set'),
        expect.any(String),
      );
    } finally {
      restore();
    }
  });

  it('treats an empty list as unset rather than as "nobody"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = withAllowlist('  ,  ,');
    try {
      expect(assertBulkPiiExporter(asRequest('anyone@altohr.com'))).toBe('unset');
    } finally {
      restore();
    }
  });
});
