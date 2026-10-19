import type { Prisma, PrismaClient } from '@prisma/client';
import { COLOR, SIZE, createDoc, fmt } from './docKit/index.js';
import { round2 } from './payroll.js';

/**
 * Tier-1 — garnishment remittance accrual + advice PDF.
 *
 * Withholding under a court/agency order is only half the obligation —
 * the money must reach the payee (state disbursement unit, IRS, the
 * creditor's attorney). When a run disburses, this groups its
 * GarnishmentDeduction rows by payee into GarnishmentRemittance rows so
 * finance has an explicit send-queue with amounts, addresses, and case
 * numbers, instead of the deductions silently accumulating in the
 * general account.
 *
 * Idempotent per (run, payee): re-accrual refreshes PENDING amounts and
 * leaves SENT rows alone.
 */

export async function accrueRemittancesForRun(
  prisma: PrismaClient,
  runId: string,
): Promise<void> {
  const deductions = await prisma.garnishmentDeduction.findMany({
    where: { payrollRunId: runId },
    include: {
      garnishment: {
        select: { remitTo: true, remitAddress: true, agencyName: true, kind: true },
      },
    },
  });
  if (deductions.length === 0) return;

  const byPayee = new Map<string, { address: string | null; total: number; ids: string[] }>();
  for (const d of deductions) {
    const payee =
      d.garnishment.remitTo?.trim() ||
      d.garnishment.agencyName?.trim() ||
      `Unspecified payee (${d.garnishment.kind})`;
    const acc = byPayee.get(payee) ?? {
      address: d.garnishment.remitAddress ?? null,
      total: 0,
      ids: [],
    };
    acc.total = round2(acc.total + Number(d.amount));
    acc.ids.push(d.id);
    byPayee.set(payee, acc);
  }

  // One read for all payees (was a findUnique per payee), then pipelined
  // batched writes. Payloads are payee-distinct, so the writes stay per-row
  // but run as array-form transactions (one round of statements) instead of
  // an awaited round trip each.
  const existingRows = await prisma.garnishmentRemittance.findMany({
    where: { payrollRunId: runId, payeeName: { in: [...byPayee.keys()] } },
  });
  const existingByPayee = new Map(existingRows.map((r) => [r.payeeName, r]));

  const toCreate: Array<{ payeeName: string; acc: { address: string | null; total: number; ids: string[] } }> = [];
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (const [payeeName, acc] of byPayee) {
    const existing = existingByPayee.get(payeeName);
    if (existing?.status === 'SENT') continue;
    if (existing) {
      writes.push(
        prisma.garnishmentRemittance.update({
          where: { id: existing.id },
          data: { amount: acc.total, payeeAddress: acc.address },
        }),
        prisma.garnishmentDeduction.updateMany({
          where: { id: { in: acc.ids } },
          data: { remittanceId: existing.id },
        }),
      );
    } else {
      toCreate.push({ payeeName, acc });
    }
  }

  if (toCreate.length > 0) {
    const created = await prisma.$transaction(
      toCreate.map(({ payeeName, acc }) =>
        prisma.garnishmentRemittance.create({
          data: {
            payrollRunId: runId,
            payeeName,
            payeeAddress: acc.address,
            amount: acc.total,
          },
        }),
      ),
    );
    created.forEach((remittance, i) => {
      writes.push(
        prisma.garnishmentDeduction.updateMany({
          where: { id: { in: toCreate[i]!.acc.ids } },
          data: { remittanceId: remittance.id },
        }),
      );
    });
  }
  if (writes.length > 0) {
    await prisma.$transaction(writes);
  }
}

export interface RemittanceAdviceData {
  companyName: string;
  ein: string;
  payeeName: string;
  payeeAddress: string | null;
  period: { start: string; end: string };
  status: string;
  reference: string | null;
  lines: Array<{
    employeeName: string;
    caseNumber: string | null;
    kind: string;
    amount: number;
  }>;
  generatedAt: string;
}

/** Remittance advice — the sheet that accompanies the payment so the
 *  agency can post each employee's amount to the right case. */
export async function renderRemittanceAdvicePdf(data: RemittanceAdviceData): Promise<Buffer> {
  const { k } = createDoc({ title: `Remittance advice · ${data.payeeName}`, author: data.companyName });
  const total = round2(data.lines.reduce((s2, l) => s2 + l.amount, 0));
  let y = k.masthead({
    title: 'Remittance advice',
    subtitle: 'Withholding orders · payment detail',
    brand: { name: data.companyName, lines: [`EIN ${fmt.ein(data.ein)}`] },
    meta: [
      { label: 'Pay period', value: fmt.dateRange(data.period.start, data.period.end) },
      { label: 'Status', value: data.status.charAt(0) + data.status.slice(1).toLowerCase() },
      { label: 'Reference', value: data.reference ?? '—' },
      { label: 'Prepared', value: fmt.date(data.generatedAt) },
    ],
  });
  // The payee block sits where a window envelope shows it.
  k.text('Pay to', k.L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
  k.text(data.payeeName, k.L, y + 11, { size: SIZE.lead, weight: 'semibold', width: k.width() * 0.6 });
  let py = y + 27;
  for (const l of (data.payeeAddress ?? '').split('\n').filter(Boolean)) {
    k.text(l, k.L, py, { size: SIZE.body, color: COLOR.ink2, width: k.width() * 0.6 });
    py += 12;
  }
  y = Math.max(py, y + 27);
  y = k.figures([{ label: 'Total remitted', value: fmt.money(total), emphasis: true }, { label: 'Orders paid', value: String(data.lines.length) }], y + 8, { w: k.width() * 0.6 });
  y = k.section('Payment detail', y, 'One line per order');
  k.table({
    y,
    rows: data.lines,
    columns: [
      { key: 'emp', header: 'Employee', width: 3.4, value: (l) => l.employeeName },
      { key: 'case', header: 'Case number', width: 2.4, value: (l) => l.caseNumber ?? '—' },
      { key: 'kind', header: 'Order type', width: 2.4, value: (l) => l.kind.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) },
      { key: 'amt', header: 'Amount', width: 1.8, align: 'right', value: (l) => fmt.money(l.amount), strong: true },
    ],
    totals: { emp: 'Total remitted', amt: fmt.money(total) },
  });
  return k.finish({ reference: data.reference ? `Remittance ${data.reference}` : 'Remittance advice', note: data.companyName });
}
