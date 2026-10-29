import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apportion, billLines, computeStatementSnapshot, type StatementSnapshot } from '../../lib/clientStatement.js';
import { carryCents, completeStatementSnapshot, statementCsvRows } from '../../lib/statementPdf.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * Audit 2026-10-29 CODE-13 / MONEY-22: a client's invoice adds up. Lines
 * were rounded one by one and the total rounded the unrounded sum, so three
 * 20-minute lines at $10 printed 3.33 + 3.33 + 3.33 under a $10.00 total;
 * and the rate column (amount ÷ hours, rounded) times the hours didn't give
 * the amount. Now every line verifies (hours × rate = amount, to the cent),
 * the lines add up to the services total, the work-site split adds up too,
 * and the CSV lists everything its total includes.
 */

const cents = (n: number) => Math.round(n * 100);
const sumCents = (xs: number[]) => xs.reduce((a, b) => a + cents(b), 0);

describe('apportion (largest remainder)', () => {
  it('whole units that add up to the target, each within one of its share', () => {
    expect(apportion([33.333, 33.333, 33.334], 100)).toEqual([33, 33, 34]);
    expect(apportion([33.3333, 33.3333, 33.3333], 100)).toEqual([34, 33, 33]);
    expect(apportion([10.5, 10.5], 20)).toEqual([10, 10]);
    expect(apportion([], 0)).toEqual([]);
  });
});

describe('billLines — every line verifies and the lines add up', () => {
  it('three 20-minute lines at $10 bill $10.00, not 9.99 under a 10.00 total', () => {
    const third = 20 / 60;
    const { lines } = billLines([
      { label: 'Associate — Barista — regular', hours: third, rate: 10 },
      { label: 'Associate — Cashier — regular', hours: third, rate: 10 },
      { label: 'Associate — Host — regular', hours: third, rate: 10 },
    ]);
    expect(sumCents(lines.map((l) => l.amount))).toBe(1000);
    expect(sumCents(lines.map((l) => l.hours))).toBe(100);
    for (const l of lines) expect(cents(l.hours * l.rate)).toBe(cents(l.amount));
  });

  it('bills overtime at a cents rate and drops a sliver that rounds to nothing', () => {
    const { lines } = billLines([
      { label: 'Associate — Cook — overtime (1.5×)', hours: 2.004, rate: 26 },
      { label: 'Associate — Cook — overtime (1.5×)', hours: 0.001, rate: 27.5 },
      { label: 'Associate — Cook — regular', hours: 40, rate: 17.33 },
    ]);
    expect(lines.map((l) => l.label)).toEqual(['Associate — Cook — overtime (1.5×)', 'Associate — Cook — regular']);
    expect(lines[0]).toEqual({ label: 'Associate — Cook — overtime (1.5×)', hours: 2.01, rate: 26, amount: 52.26 });
    expect(lines[1]!.amount).toBe(693.2);
  });
});

describe('frozen statements and the CSV', () => {
  const frozen: StatementSnapshot = {
    clientName: 'Harbor Cafe',
    periodStart: '2026-10-17',
    periodEnd: '2026-10-23',
    lines: [
      { label: 'Associate — Barista — regular', hours: 0.33, rate: 10, amount: 3.33 },
      { label: 'Associate — Cashier — regular', hours: 0.33, rate: 10, amount: 3.33 },
      { label: 'Associate — Host — regular', hours: 0.33, rate: 10, amount: 3.33 },
      { label: 'Associate — Host — overtime (1.5×)', hours: 0, rate: 0, amount: 0 },
    ],
    stores: [{ locationName: 'Harbor Cafe', hours: 1, amount: 10 }],
    adjustments: [{ kind: 'RETRO', label: 'Retro pay rebilled', basis: 'Oct 3 – 9', hours: 2, amount: 4.5 } as never],
    totals: { hours: 1, regularHours: 1, otHours: 0, amount: 15.12, hoursAmount: 10, adjustmentsAmount: 4.5, subtotal: 14.5, salesTaxRatePct: 4.25, salesTax: 0.62 },
    sla: { publishedShifts: 3, assignedShifts: 3, fillRatePct: 100, punctualPct: 100, noShows: 0, pendingEntries: 0 },
  };

  it('a frozen invoice carries its rounding cent on a line, so the lines still add up to the total it billed', () => {
    const s = completeStatementSnapshot(frozen, 'Client');
    expect(sumCents(s.lines.map((l) => l.amount))).toBe(1000);
    // A real gap (not rounding) is never hidden.
    expect(carryCents([{ amount: 1 }, { amount: 2 }], 10, () => '')).toEqual([{ amount: 1 }, { amount: 2 }]);
  });

  it('the CSV lists every line its total includes: hours, adjustments, tax', () => {
    const rows = statementCsvRows(frozen, { status: 'FINAL', number: 1093, finalizedAt: new Date('2026-10-24T15:00:00Z'), dueDate: new Date('2026-11-23T12:00:00Z'), poNumber: 'PO-77' });
    const amountOf = (label: string) => rows.find((r) => r[0] === label)?.[3];
    const services = rows.filter((r) => typeof r[0] === 'string' && (r[0] as string).startsWith('Associate —'));
    // The 0.00-hour overtime line is gone; the rest add up to the services subtotal.
    expect(services).toHaveLength(3);
    expect(sumCents(services.map((r) => r[3] as number))).toBe(cents(amountOf('Services subtotal') as number));
    expect(rows.some((r) => r[0] === 'Retro pay rebilled' && r[3] === 4.5)).toBe(true);
    expect(cents(amountOf('Services subtotal') as number) + cents(amountOf('Adjustments subtotal') as number)).toBe(cents(amountOf('Subtotal') as number));
    expect(cents(amountOf('Subtotal') as number) + cents(amountOf('Sales tax (4.25%)') as number)).toBe(cents(amountOf('Total') as number));
    expect(rows.find((r) => r[0] === 'Due date')?.[1]).toBe('Nov 23, 2026');
    expect(rows.find((r) => r[0] === 'Service period')?.[1]).toBe('Oct 17 – Oct 23, 2026');
    expect(rows.find((r) => r[0] === 'Statement')?.[1]).toBe('Invoice No. 1093');
  });
});

describe('computeStatementSnapshot — the invoice adds up end to end', () => {
  let clientId = '';
  const start = new Date('2026-10-17T04:00:00.000Z');
  const endEx = new Date('2026-10-24T04:00:00.000Z');

  beforeAll(async () => {
    await truncateAll();
    const client = await createClient('Rounding Cafe');
    clientId = client.id;
    const site = await prisma.site.findFirstOrThrow({ where: { clientId } });
    const a = await createAssociate({ firstName: 'Rae', lastName: 'Round' });
    // Three positions, 20 minutes each, at $10 an hour.
    for (const [i, position] of ['Barista', 'Cashier', 'Host'].entries()) {
      const startsAt = new Date(Date.UTC(2026, 9, 19, 14 + i, 0));
      const shift = await prisma.shift.create({ data: { clientId, locationId: site.id, position, startsAt, endsAt: new Date(startsAt.getTime() + 20 * 60_000), hourlyRate: 10, status: 'COMPLETED', publishedAt: new Date('2026-10-10T12:00:00Z'), assignedAssociateId: a.id } });
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId, locationId: site.id, shiftId: shift.id, clockInAt: startsAt, clockOutAt: new Date(startsAt.getTime() + 20 * 60_000), status: 'APPROVED', approvedAt: new Date() } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('lines verify, add up to the services total, and the site split matches', async () => {
    const s = await computeStatementSnapshot(prisma, clientId, start, endEx);
    expect(s.lines).toHaveLength(3);
    for (const l of s.lines) expect(cents(l.hours * l.rate)).toBe(cents(l.amount));
    expect(sumCents(s.lines.map((l) => l.amount))).toBe(cents(s.totals.hoursAmount!));
    expect(s.totals.hoursAmount).toBe(10);
    expect(s.totals.amount).toBe(10);
    expect(sumCents(s.lines.map((l) => l.hours))).toBe(cents(s.totals.hours));
    expect(s.totals.hours).toBe(1);
    expect(sumCents(s.stores.map((st) => st.amount))).toBe(1000);
    expect(sumCents(s.stores.map((st) => st.hours))).toBe(100);
  });
});
