import type { PrismaClient, RecurringBill } from '@prisma/client';
import { BooksBillLineInputSchema, type BooksBillLineInput, type BooksRecurringBill, type BooksRecurringBillInput } from '@alto-people/shared';
import { z } from 'zod';
import { HttpError } from '../../../middleware/error.js';
import { enqueueAudit } from '../../audit.js';
import { tenantIdForWrite } from '../../tenant.js';
import { createBill, submitBill } from './bills.js';
import { cents, dateOnly, dollars, todayYmd, ymd, type Db } from './shared.js';
import { vendorInReach } from './vendors.js';

/**
 * Recurring bills — rent, the van lease, the software that bills the same
 * every month. A template names the vendor, the lines and the cadence; on
 * each date the job (lib/books/jobs/payables) makes that date's bill — a
 * draft, or sent straight to approval when the template says so. Never two
 * bills for one template and one date.
 *
 * RecurringBill.template holds { lines, autoSubmit } (an older bare array of
 * lines reads as lines with autoSubmit off).
 */

const TemplateSchema = z.union([
  z.array(BooksBillLineInputSchema),
  z.object({ lines: z.array(BooksBillLineInputSchema), autoSubmit: z.boolean().optional() }),
]);

export function readTemplate(t: unknown): { lines: BooksBillLineInput[]; autoSubmit: boolean } {
  const parsed = TemplateSchema.safeParse(t);
  if (!parsed.success) return { lines: [], autoSubmit: false };
  return Array.isArray(parsed.data) ? { lines: parsed.data, autoSubmit: false } : { lines: parsed.data.lines, autoSubmit: !!parsed.data.autoSubmit };
}

/** The date after `d` on the template's cadence (month-end stays month-end). */
export function nextOccurrence(d: string, frequency: string): string {
  const date = dateOnly(d);
  if (frequency === 'WEEKLY') return ymd(new Date(date.getTime() + 7 * 86_400_000));
  const months = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12;
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const wasLast = day === new Date(Date.UTC(y, date.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(y, m, wasLast ? lastOfTarget : Math.min(day, lastOfTarget))));
}

export async function shapeRecurring(db: Db, rows: RecurringBill[]): Promise<BooksRecurringBill[]> {
  if (rows.length === 0) return [];
  const [vendors, counts] = await Promise.all([
    db.vendor.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.vendorId))] } }, select: { id: true, name: true } }),
    db.bill.groupBy({ by: ['recurringId'], where: { recurringId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
  ]);
  const vName = new Map(vendors.map((v) => [v.id, v.name]));
  const made = new Map(counts.map((c) => [c.recurringId, c._count._all]));
  return rows.map((r) => {
    const t = readTemplate(r.template);
    return {
      id: r.id,
      vendorId: r.vendorId,
      vendorName: vName.get(r.vendorId) ?? 'A vendor',
      name: r.name,
      frequency: r.frequency as BooksRecurringBill['frequency'],
      nextDate: ymd(r.nextDate),
      endDate: r.endDate ? ymd(r.endDate) : null,
      memo: r.memo,
      amount: dollars(t.lines.reduce((s, l) => s + cents(l.amount), 0)),
      lines: t.lines,
      autoSubmit: t.autoSubmit,
      isActive: r.isActive,
      billsMade: made.get(r.id) ?? 0,
    };
  });
}

export async function createRecurring(db: Db, input: BooksRecurringBillInput, actorUserId: string): Promise<RecurringBill> {
  await vendorInReach(db, input.vendorId);
  if (input.endDate && input.endDate < input.nextDate) throw new HttpError(400, 'end_before_next', 'The end date is before the first bill.');
  const row = await db.recurringBill.create({
    data: {
      tenantId: tenantIdForWrite(),
      vendorId: input.vendorId,
      name: input.name,
      frequency: input.frequency,
      nextDate: dateOnly(input.nextDate),
      endDate: input.endDate ? dateOnly(input.endDate) : null,
      memo: input.memo ?? null,
      template: { lines: input.lines, autoSubmit: !!input.autoSubmit },
      createdById: actorUserId,
    },
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.recurring_bill_created', entityType: 'RecurringBill', entityId: row.id, metadata: { name: row.name, frequency: row.frequency } }, 'books.payables');
  return row;
}

export async function updateRecurring(db: Db, row: RecurringBill, input: Partial<BooksRecurringBillInput> & { isActive?: boolean }, actorUserId: string): Promise<RecurringBill> {
  if (input.vendorId) await vendorInReach(db, input.vendorId);
  const t = readTemplate(row.template);
  const updated = await db.recurringBill.update({
    where: { id: row.id },
    data: {
      ...(input.vendorId ? { vendorId: input.vendorId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.frequency ? { frequency: input.frequency } : {}),
      ...(input.nextDate ? { nextDate: dateOnly(input.nextDate) } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate ? dateOnly(input.endDate) : null } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.lines || input.autoSubmit !== undefined ? { template: { lines: input.lines ?? t.lines, autoSubmit: input.autoSubmit ?? t.autoSubmit } } : {}),
    },
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.recurring_bill_updated', entityType: 'RecurringBill', entityId: row.id, metadata: { fields: Object.keys(input) } }, 'books.payables');
  return updated;
}

/**
 * Make every bill whose date has come, for the tenant in context. Catches
 * up a template that missed days (the job was down) one date at a time.
 */
export async function makeDueRecurringBills(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const today = todayYmd(now);
  const due = await db.recurringBill.findMany({ where: { tenantId: tenantIdForWrite(), isActive: true, nextDate: { lte: dateOnly(today) } } });
  let made = 0;
  for (const r of due) {
    const t = readTemplate(r.template);
    let next = ymd(r.nextDate);
    for (let guard = 0; guard < 60 && next <= today; guard++) {
      if (r.endDate && next > ymd(r.endDate)) break;
      // One bill per template per date: a second run finds it and moves on. Two runs at once both pass
      // the check; the unique (recurringId, billDate) key turns the second insert away (deep audit CODE-23).
      const exists = await db.bill.findFirst({ where: { recurringId: r.id, billDate: dateOnly(next) }, select: { id: true } });
      if (!exists && t.lines.length > 0) {
        const bill = await createBill(db, { vendorId: r.vendorId, billDate: next, memo: r.memo ?? r.name, billNumber: null, lines: t.lines }, r.createdById, { recurringId: r.id }).catch((err: unknown) => {
          if ((err as { code?: string }).code === 'P2002') return null; // the other run made it
          throw err;
        });
        if (bill) {
          if (t.autoSubmit) await submitBill(db, bill, r.createdById);
          made += 1;
        }
      }
      next = nextOccurrence(next, r.frequency);
    }
    const ended = !!r.endDate && next > ymd(r.endDate);
    await db.recurringBill.update({ where: { id: r.id }, data: { nextDate: dateOnly(next), ...(ended ? { isActive: false } : {}) } });
  }
  return made;
}
