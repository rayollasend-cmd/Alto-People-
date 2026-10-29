import { describe, expect, it } from 'vitest';
import { execHref, readsExecFrame } from '@/lib/executiveApi';
import { fmtExecAsOf } from '@/lib/executiveFormat';

/**
 * The executive frame on drill links (deep audit 2026-10-29, LEAD-15/17):
 * an executive page opens in the chairman's period and comparison; every
 * other page keeps its own URL (a client's record has its own month and
 * week, so `?period=month` there only promised a frame it ignores). And
 * "as of" is read on the company's clock, with its zone.
 */
describe('execHref', () => {
  const month = { period: 'month', compare: 'year' } as const;

  it('keeps the frame on the executive home and pages', () => {
    expect(execHref('/executive/clients', month)).toBe('/executive/clients?period=month&compare=year');
    expect(execHref('/executive/risk?open=leave-deadlines', month)).toBe('/executive/risk?open=leave-deadlines&period=month&compare=year');
    expect(execHref('/', month)).toBe('/?period=month&compare=year');
    expect(execHref('/executive/financials#cash', month)).toBe('/executive/financials?period=month&compare=year#cash');
  });

  it('leaves the clean URL clean on the default frame', () => {
    expect(execHref('/executive/clients', { period: 'quarter', compare: 'prior' })).toBe('/executive/clients');
  });

  it('never adds the frame to a page that does not read it', () => {
    for (const path of ['/clients/c1', '/leave?status=notices', '/books/receivables', '/compliance?tab=i9', '/people?workStatus=ACTIVE']) {
      expect(readsExecFrame(path)).toBe(false);
      expect(execHref(path, month)).toBe(path);
    }
  });
});

describe('fmtExecAsOf', () => {
  it('reads the instant on the company clock with its abbreviation', () => {
    // 06:30Z on Oct 29 is 11:30 PM Pacific on Oct 28 — and already 2:30 AM on the 29th in an
    // Eastern company: the page says the company's time, not the browser's.
    expect(fmtExecAsOf('2026-10-29T03:30:00.000Z', 'America/New_York')).toBe('11:30 PM EDT');
    expect(fmtExecAsOf('2026-10-29T06:30:00.000Z', 'America/New_York')).toBe('2:30 AM EDT');
  });
});
