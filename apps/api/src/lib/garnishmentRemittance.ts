import type { PrismaClient } from '@prisma/client';
import PDFDocument from 'pdfkit';
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

  for (const [payeeName, acc] of byPayee) {
    const existing = await prisma.garnishmentRemittance.findUnique({
      where: { payrollRunId_payeeName: { payrollRunId: runId, payeeName } },
    });
    if (existing?.status === 'SENT') continue;
    const remittance = existing
      ? await prisma.garnishmentRemittance.update({
          where: { id: existing.id },
          data: { amount: acc.total, payeeAddress: acc.address },
        })
      : await prisma.garnishmentRemittance.create({
          data: {
            payrollRunId: runId,
            payeeName,
            payeeAddress: acc.address,
            amount: acc.total,
          },
        });
    await prisma.garnishmentDeduction.updateMany({
      where: { id: { in: acc.ids } },
      data: { remittanceId: remittance.id },
    });
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

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Remittance advice — the sheet that accompanies the payment so the
 *  agency can post each employee's amount to the right case. */
export function renderRemittanceAdvicePdf(data: RemittanceAdviceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(15).text('Garnishment remittance advice');
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`From: ${data.companyName} — EIN ${data.ein.slice(0, 2)}-${data.ein.slice(2)}`)
      .moveDown(0.5)
      .font('Helvetica-Bold')
      .text(`To: ${data.payeeName}`);
    if (data.payeeAddress) doc.font('Helvetica').text(data.payeeAddress);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#666666')
      .moveDown(0.5)
      .text(`Pay period ${data.period.start} to ${data.period.end} · ${data.status}${data.reference ? ` · ref ${data.reference}` : ''} · generated ${data.generatedAt}`)
      .fillColor('#000000')
      .moveDown(1);

    const cols = { emp: 56, caseN: 250, kind: 380, amt: 480 };
    doc.font('Helvetica-Bold').fontSize(9);
    const hy = doc.y;
    doc.text('Employee', cols.emp, hy);
    doc.text('Case number', cols.caseN, hy);
    doc.text('Type', cols.kind, hy);
    doc.text('Amount', cols.amt, hy, { width: 76, align: 'right' });
    doc.moveTo(56, doc.y + 2).lineTo(556, doc.y + 2).strokeColor('#999999').stroke().strokeColor('#000000');
    doc.moveDown(0.4);

    doc.font('Helvetica').fontSize(9);
    let total = 0;
    for (const line of data.lines) {
      if (doc.y > 690) doc.addPage();
      const y = doc.y;
      doc.text(line.employeeName.slice(0, 34), cols.emp, y, { width: 186 });
      doc.text(line.caseNumber ?? '—', cols.caseN, y, { width: 120 });
      doc.text(line.kind.replace(/_/g, ' ').toLowerCase(), cols.kind, y, { width: 92 });
      doc.text(money(line.amount), cols.amt, y, { width: 76, align: 'right' });
      total += line.amount;
      doc.y = y + 16;
    }
    doc.moveTo(380, doc.y).lineTo(556, doc.y).stroke();
    doc.moveDown(0.3);
    const ty = doc.y;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Total remitted', cols.kind, ty);
    doc.text(money(round2(total)), cols.amt, ty, { width: 76, align: 'right' });
    doc.end();
  });
}
