import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { payableMs } from './payroll.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Billed, not paid (finance walk 11): the other direction of pay-and-bill.
 * Approved hours a FINAL client statement billed, by person and week, that
 * no locked paystub covers — the client was charged for work nobody was
 * paid for (a missed run, a person left off a schedule).
 */
export interface BilledNotPaidRow {
  associateId: string;
  associateName: string;
  clientId: string;
  clientName: string;
  weekStart: string;
  hours: number;
  statementId: string;
  statementNumber: number | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

export async function billedNotPaid(db: Db, input: { periodStart: Date; periodEnd: Date; clientId?: string | null; runWhere?: Prisma.PayrollRunWhereInput }): Promise<{ rows: BilledNotPaidRow[]; hours: number }> {
  const tenantId = tenantIdForWrite();
  const endEx = new Date(input.periodEnd.getTime() + DAY);
  const statements = await db.clientStatement.findMany({
    where: { tenantId, status: 'FINAL', periodStart: { lt: endEx }, periodEnd: { gte: input.periodStart }, ...(input.clientId ? { clientId: input.clientId } : {}) },
    select: { id: true, number: true, clientId: true, periodStart: true, periodEnd: true, client: { select: { name: true } } },
    take: 500,
  });
  if (statements.length === 0) return { rows: [], hours: 0 };
  const from = new Date(Math.max(input.periodStart.getTime(), Math.min(...statements.map((s) => s.periodStart.getTime()))));
  const to = new Date(Math.min(endEx.getTime(), Math.max(...statements.map((s) => s.periodEnd.getTime())) + DAY));
  const [entries, runs] = await Promise.all([
    db.timeEntry.findMany({
      where: { tenantId, status: 'APPROVED', clockInAt: { gte: from, lt: to }, clientId: { in: [...new Set(statements.map((s) => s.clientId))] } },
      select: { associateId: true, clientId: true, status: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } }, associate: { select: { firstName: true, lastName: true } } },
      take: 100_000,
    }),
    db.payrollRun.findMany({
      where: { AND: [input.runWhere ?? { tenantId }, { status: { in: ['FINALIZED', 'DISBURSED'] }, kind: { not: 'AMENDMENT' }, periodEnd: { gte: from }, periodStart: { lt: to } }] },
      select: { periodStart: true, periodEnd: true, items: { where: { status: { not: 'VOIDED' } }, select: { associateId: true } } },
    }),
  ]);
  const paidOn = (associateId: string, day: string) => runs.some((r) => ymd(r.periodStart) <= day && day <= ymd(r.periodEnd) && r.items.some((i) => i.associateId === associateId));
  const byKey = new Map<string, BilledNotPaidRow & { ms: number }>();
  for (const e of entries) {
    const day = ymd(e.clockInAt);
    const st = statements.find((s) => s.clientId === e.clientId && ymd(s.periodStart) <= day && day <= ymd(s.periodEnd));
    if (!st || paidOn(e.associateId, day)) continue;
    const week = ymd(startOfWeekUTC(e.clockInAt));
    const key = `${e.associateId}:${st.clientId}:${week}`;
    const row = byKey.get(key) ?? {
      associateId: e.associateId,
      associateName: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
      clientId: st.clientId,
      clientName: st.client.name,
      weekStart: week,
      hours: 0,
      statementId: st.id,
      statementNumber: st.number,
      ms: 0,
    };
    row.ms += payableMs(e);
    byKey.set(key, row);
  }
  const rows = [...byKey.values()]
    .map(({ ms, ...r }) => ({ ...r, hours: Math.round((ms / 3_600_000) * 100) / 100 }))
    .filter((r) => r.hours > 0)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.associateName.localeCompare(b.associateName));
  return { rows, hours: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100 };
}
