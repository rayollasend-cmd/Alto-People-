import type { BooksApAging, BooksApAgingRow, BooksVendor1099Report } from '@alto-people/shared';
import { f1099NecThreshold } from '../../f1099NecAggregator.js';
import { tenantIdForWrite } from '../../tenant.js';
import { cents, dateOnly, daysBetween, dollars, todayYmd, ymd, type Db } from './shared.js';

/**
 * Payables reports: what's owed by how late (AP aging), and what was paid
 * to 1099 vendors in a year (the 1099-NEC list).
 */

type Buckets = Omit<BooksApAgingRow, 'vendorId' | 'vendorName'>;
const empty = (): Buckets => ({ current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0, bills: 0 });

/** Open bills (approved, unpaid balance) by vendor, by days past their due date as of `asOf`. */
export async function apAging(db: Db, asOf: string = todayYmd()): Promise<BooksApAging> {
  const bills = await db.bill.findMany({
    where: { tenantId: tenantIdForWrite(), status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, billDate: { lte: dateOnly(asOf) } },
    select: { vendorId: true, dueDate: true, balance: true, vendor: { select: { name: true } } },
  });
  const byVendor = new Map<string, { name: string; c: Buckets }>();
  const totals = empty();
  for (const b of bills) {
    const owed = cents(b.balance);
    if (owed <= 0) continue;
    const late = daysBetween(ymd(b.dueDate), asOf);
    const key: keyof Buckets = late <= 0 ? 'current' : late <= 30 ? 'days1to30' : late <= 60 ? 'days31to60' : late <= 90 ? 'days61to90' : 'over90';
    const row = byVendor.get(b.vendorId) ?? { name: b.vendor.name, c: empty() };
    for (const t of [row.c, totals]) {
      t[key] += owed;
      t.total += owed;
      t.bills += 1;
    }
    byVendor.set(b.vendorId, row);
  }
  const toDollars = (c: Buckets): Buckets => ({
    current: dollars(c.current),
    days1to30: dollars(c.days1to30),
    days31to60: dollars(c.days31to60),
    days61to90: dollars(c.days61to90),
    over90: dollars(c.over90),
    total: dollars(c.total),
    bills: c.bills,
  });
  const rows = [...byVendor.entries()]
    .map(([vendorId, r]) => ({ vendorId, vendorName: r.name, ...toDollars(r.c) }))
    .sort((a, b) => b.total - a.total || a.vendorName.localeCompare(b.vendorName));
  return { asOf, rows, totals: toDollars(totals) };
}

/**
 * Payments to 1099 vendors in a calendar year. Card payments don't count
 * toward the 1099-NEC (the card network reports them on a 1099-K); the
 * threshold is the year's ($600 through 2025, $2,000 from 2026).
 */
export async function vendor1099(db: Db, year: number): Promise<BooksVendor1099Report> {
  const threshold = f1099NecThreshold(year);
  const vendors = await db.vendor.findMany({ where: { tenantId: tenantIdForWrite(), is1099: true, deletedAt: null }, orderBy: { name: 'asc' } });
  const payments = await db.billPayment.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      vendorId: { in: vendors.map((v) => v.id) },
      status: { not: 'VOID' },
      paidOn: { gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) },
    },
    select: { vendorId: true, amount: true, method: true },
  });
  const rows = vendors.map((v) => {
    const mine = payments.filter((p) => p.vendorId === v.id);
    const reportable = mine.filter((p) => p.method !== 'CARD').reduce((s, p) => s + cents(p.amount), 0);
    const card = mine.filter((p) => p.method === 'CARD').reduce((s, p) => s + cents(p.amount), 0);
    const total = dollars(reportable);
    const needs1099 = total >= threshold;
    const missing: string[] = [];
    if (needs1099 && !v.taxIdEnc) missing.push('tax ID (ask for a W-9)');
    if (needs1099 && !(v.addressLine1 && v.city && v.state && v.zip)) missing.push('mailing address');
    const address = [v.addressLine1, v.addressLine2, [v.city, v.state].filter(Boolean).join(', '), v.zip].filter(Boolean).join(' · ') || null;
    return { vendorId: v.id, name: v.name, hasTaxId: !!v.taxIdEnc, taxIdLast4: v.taxIdLast4, address, total, cardTotal: dollars(card), payments: mine.length, needs1099, missing };
  });
  rows.sort((a, b) => Number(b.needs1099) - Number(a.needs1099) || b.total - a.total || a.name.localeCompare(b.name));
  return { year, threshold, rows };
}
