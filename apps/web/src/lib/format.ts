/**
 * Centralized formatters. Pages have spawned ~3 implementations of money
 * (`toLocaleString(currency)`, custom `fmtPay`, bare `$${n}`) and a
 * matching spread of date formats. This module is the one place every
 * surface should reach for, so a single tweak (e.g., the currency symbol
 * convention for an EU client) updates the whole app at once.
 *
 * Conventions:
 *   - Money: en-US, 2 decimals always (never strip trailing zeros — the
 *     visual rhythm of `$24.00` next to `$24.50` matters in a table).
 *   - Dates: prefer "May 13, 2026" over "5/13/26"; year is included
 *     because HR data spans years.
 *   - Percent: 1 decimal by default, no `.0` if integer.
 *   - All formatters accept null/undefined and return '—' so callers
 *     don't have to scatter null guards.
 */

const EN_US = 'en-US';
const DASH = '—';

export function fmtMoney(
  value: number | string | null | undefined,
  opts: { currency?: string; precise?: boolean } = {},
): string {
  if (value === null || value === undefined || value === '') return DASH;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString(EN_US, {
    style: 'currency',
    currency: opts.currency ?? 'USD',
    minimumFractionDigits: 2,
    // `precise` keeps 4 decimals — for things like hourly rates derived
    // from cents-precision data (24.0625/hr instead of 24.06).
    maximumFractionDigits: opts.precise ? 4 : 2,
  });
}

/** "/hr" or "/yr" suffix tacked on for pay rates. */
export function fmtPayRate(
  amount: number | string | null | undefined,
  payType: 'HOURLY' | 'SALARY' | null | undefined,
): string {
  const money = fmtMoney(amount);
  if (money === DASH) return DASH;
  if (payType === 'SALARY') return `${money}/yr`;
  if (payType === 'HOURLY') return `${money}/hr`;
  return money;
}

export function fmtPercent(
  value: number | null | undefined,
  opts: { decimals?: number; fromFraction?: boolean } = {},
): string {
  if (value === null || value === undefined) return DASH;
  if (!Number.isFinite(value)) return DASH;
  // Pass `fromFraction: true` when the value is 0–1 (e.g., 0.05 → 5%).
  const pct = opts.fromFraction ? value * 100 : value;
  const decimals = opts.decimals ?? 1;
  // Drop the trailing `.0` for whole numbers: 5% not 5.0%.
  const rounded = Math.round(pct * 10 ** decimals) / 10 ** decimals;
  if (Number.isInteger(rounded)) return `${rounded}%`;
  return `${rounded.toFixed(decimals)}%`;
}

/** "May 13, 2026". Accepts ISO date or full datetime. */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "May 13, 2026, 9:31 AM". For event timestamps. */
export function fmtDateTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(EN_US, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "9:31 AM". For times where the date is implicit (today's punches, etc.). */
export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString(EN_US, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "2h ago", "yesterday", "Mar 4". For activity feeds. */
export function fmtRelativeDate(
  value: string | Date | null | undefined,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return fmtDate(d);
}
