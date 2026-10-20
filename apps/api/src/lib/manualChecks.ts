import { Prisma, type PayrollEarningKind, type PrismaClient } from '@prisma/client';
import { recordCriticalAudit } from './audit.js';
import { HttpError } from '../middleware/error.js';
import { computeEmployerTaxes } from './payrollTax.js';
import { computeYtdWages } from './payrollYtd.js';
import { tenantIdForWrite } from './tenant.js';
import { booksAfterPayrollRun } from './books/posting/hooks.js';

/**
 * Manual checks and third-party sick pay (PAYEXP §3).
 *
 *   A handwritten check (a final check cut at the store, a correction paid
 *   on the spot) already left: recording it puts it in payroll history and
 *   YTD exactly like a paid run — one MANUAL run with one DISBURSED item —
 *   and posts the tax liabilities it created. Voiding takes it back out of
 *   YTD and drops the liabilities not yet scheduled; replacing voids it and
 *   records the new check against the old one.
 *
 *   Insurer-paid sick pay is not a paycheck: it is recorded on its own so
 *   the W-2 carries it (Box 1/3/5 for the taxable part, Box 12 J for the
 *   part the employee's after-tax premiums bought, Box 13 checked) and,
 *   when the insurer passed the liability back, the employer's FICA match
 *   and unemployment taxes are posted to the ledger.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ManualCheckInput {
  associateId: string;
  checkNumber: string;
  payDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  earningKind?: PayrollEarningKind;
  hours?: number | null;
  gross: number;
  preTaxDeductions?: number;
  /** The 401(k)/403(b) part of preTaxDeductions (FIT-only; FICA still applies). */
  preTaxRetirement?: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  state: number;
  local?: number;
  postTaxDeductions?: number;
  net: number;
  memo?: string | null;
}

/** The net a check's own numbers add up to. */
export function manualNet(i: Pick<ManualCheckInput, 'gross' | 'preTaxDeductions' | 'federal' | 'socialSecurity' | 'medicare' | 'state' | 'local' | 'postTaxDeductions'>): number {
  return round2(i.gross - (i.preTaxDeductions ?? 0) - i.federal - i.socialSecurity - i.medicare - i.state - (i.local ?? 0) - (i.postTaxDeductions ?? 0));
}

export async function recordManualCheck(
  db: PrismaClient,
  input: ManualCheckInput & { actorUserId: string; replacesItemId?: string | null },
): Promise<{ runId: string; itemId: string }> {
  const expected = manualNet(input);
  if (Math.abs(expected - round2(input.net)) > 0.01) {
    throw new HttpError(400, 'net_mismatch', `The numbers add up to a net of $${expected.toFixed(2)}, not $${input.net.toFixed(2)}. Check the amounts on the check.`);
  }
  if ((input.preTaxRetirement ?? 0) > (input.preTaxDeductions ?? 0)) {
    throw new HttpError(400, 'retirement_over_pretax', 'The 401(k) part can’t be more than the pre-tax deductions.');
  }
  const associate = await db.associate.findFirst({ where: { id: input.associateId, deletedAt: null }, select: { id: true, state: true, firstName: true, lastName: true } });
  if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  const dup = await db.payrollItem.findFirst({
    where: { disbursementRef: `Manual check #${input.checkNumber}`, status: { not: 'VOIDED' }, payrollRun: { kind: 'MANUAL' } },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, 'check_number_used', `Check #${input.checkNumber} is already recorded.`);

  const payDate = new Date(Date.UTC(input.payDate.getUTCFullYear(), input.payDate.getUTCMonth(), input.payDate.getUTCDate()));
  const yearStart = new Date(Date.UTC(payDate.getUTCFullYear(), 0, 1));
  const ytd = await computeYtdWages(db, associate.id, yearStart, payDate);
  const preTax = round2(input.preTaxDeductions ?? 0);
  const retirement = round2(input.preTaxRetirement ?? 0);
  // FICA base = gross less Section 125 (a 401(k) deferral stays FICA wages).
  const ficaBase = round2(input.gross - (preTax - retirement));
  const employer = computeEmployerTaxes({ grossPay: ficaBase, ytdWages: ytd, ytdMedicareWages: ytd, state: associate.state });

  const result = await db.$transaction(async (tx) => {
    let replaces: { id: string; payrollRunId: string; disbursementRef: string | null } | null = null;
    if (input.replacesItemId) {
      replaces = await tx.payrollItem.findFirst({
        where: { id: input.replacesItemId, associateId: associate.id, status: 'DISBURSED', payrollRun: { kind: 'MANUAL', status: 'DISBURSED' } },
        select: { id: true, payrollRunId: true, disbursementRef: true },
      });
      if (!replaces) throw new HttpError(404, 'check_not_found', 'That manual check isn’t on file or was already voided.');
      await voidManualCheckTx(tx, replaces.payrollRunId, `Replaced by check #${input.checkNumber}`, input.actorUserId);
    }
    const run = await tx.payrollRun.create({
      data: {
        kind: 'MANUAL',
        clientId: null,
        periodStart: input.periodStart ?? payDate,
        periodEnd: input.periodEnd ?? payDate,
        status: 'DISBURSED',
        finalizedAt: new Date(),
        disbursedAt: payDate,
        createdById: input.actorUserId,
        approvedById: input.actorUserId,
        approvedAt: new Date(),
        notes: [`Manual check #${input.checkNumber}`, replaces?.disbursementRef ? `replaces ${replaces.disbursementRef}` : null, input.memo ?? null].filter(Boolean).join(' · '),
        totalGross: round2(input.gross),
        totalTax: round2(input.federal + input.socialSecurity + input.medicare + input.state + (input.local ?? 0)),
        totalNet: round2(input.net),
        totalEmployerTax: round2(employer.fica + employer.medicare + employer.futa + employer.suta),
      },
    });
    const item = await tx.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: associate.id,
        hoursWorked: input.hours ?? 0,
        hourlyRate: input.hours && input.hours > 0 ? round2(input.gross / input.hours) : 0,
        grossPay: round2(input.gross),
        preTaxDeductions: preTax,
        preTaxRetirement: retirement,
        federalWithholding: round2(input.federal),
        fica: round2(input.socialSecurity),
        medicare: round2(input.medicare),
        stateWithholding: round2(input.state),
        localWithholding: round2(input.local ?? 0),
        postTaxDeductions: round2(input.postTaxDeductions ?? 0),
        taxState: associate.state,
        employerFica: employer.fica,
        employerMedicare: employer.medicare,
        employerFuta: employer.futa,
        employerSuta: employer.suta,
        ytdWages: ytd,
        ytdMedicareWages: ytd,
        netPay: round2(input.net),
        status: 'DISBURSED',
        disbursedAt: payDate,
        disbursementRef: `Manual check #${input.checkNumber}`,
        amendsItemId: replaces?.id ?? null,
      },
    });
    await tx.payrollItemEarning.create({
      data: {
        payrollItemId: item.id,
        kind: input.earningKind ?? 'REGULAR',
        hours: input.hours ?? null,
        rate: input.hours && input.hours > 0 ? round2(input.gross / input.hours) : null,
        amount: round2(input.gross),
        isTaxable: true,
        notes: `Manual check #${input.checkNumber}`,
      },
    });
    await tx.payrollDisbursementAttempt.create({
      data: { payrollItemId: item.id, provider: 'MANUAL', status: 'SUCCESS', externalRef: `Manual check #${input.checkNumber}`, attemptedById: input.actorUserId },
    });
    return { runId: run.id, itemId: item.id };
  });

  // The liabilities this check created (bookkeeping never fails the record).
  await postRunLiabilities(db, result.runId);
  booksAfterPayrollRun(result.runId);
  await recordCriticalAudit(
    {
      actorUserId: input.actorUserId,
      action: input.replacesItemId ? 'payroll.manual_check.replaced' : 'payroll.manual_check.recorded',
      entityType: 'PayrollRun',
      entityId: result.runId,
      metadata: { associateId: associate.id, checkNumber: input.checkNumber, gross: input.gross, net: input.net, replacesItemId: input.replacesItemId ?? null },
    },
    'manualChecks.record',
  );
  return result;
}

async function postRunLiabilities(db: PrismaClient, runId: string): Promise<void> {
  try {
    const [{ accrueDepositsForRun }, { postLiabilitiesForRun }] = await Promise.all([import('./taxDeposits.js'), import('./payrollTaxLedger.js')]);
    await accrueDepositsForRun(db, runId);
    await postLiabilitiesForRun(db, runId);
  } catch (err) {
    console.warn('[manualChecks] liability posting failed (advisory):', err);
  }
}

async function voidManualCheckTx(tx: Prisma.TransactionClient, runId: string, reason: string, actorUserId: string): Promise<void> {
  const now = new Date();
  await tx.payrollItem.updateMany({ where: { payrollRunId: runId, status: 'DISBURSED' }, data: { status: 'VOIDED', voidedAt: now } });
  await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actorUserId, cancelReason: reason } });
  // Liabilities not yet scheduled go with it; a scheduled or paid one stays for the reviewer.
  await tx.taxLiability.deleteMany({ where: { payrollRunId: runId, status: 'OPEN' } });
}

export async function voidManualCheck(db: PrismaClient, input: { runId: string; reason: string; actorUserId: string }): Promise<void> {
  const run = await db.payrollRun.findFirst({ where: { id: input.runId, kind: 'MANUAL' }, select: { id: true, status: true } });
  if (!run) throw new HttpError(404, 'check_not_found', 'Manual check not found');
  if (run.status !== 'DISBURSED') throw new HttpError(409, 'already_void', 'This check is already voided.');
  await db.$transaction((tx) => voidManualCheckTx(tx, run.id, input.reason, input.actorUserId));
  booksAfterPayrollRun(run.id);
  await recordCriticalAudit(
    { actorUserId: input.actorUserId, action: 'payroll.manual_check.voided', entityType: 'PayrollRun', entityId: run.id, metadata: { reason: input.reason } },
    'manualChecks.void',
  );
}

export async function listManualChecks(db: Db, where: Prisma.PayrollItemWhereInput = {}) {
  const items = await db.payrollItem.findMany({
    where: { AND: [where, { payrollRun: { kind: 'MANUAL' } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      associateId: true,
      grossPay: true,
      federalWithholding: true,
      fica: true,
      medicare: true,
      stateWithholding: true,
      localWithholding: true,
      netPay: true,
      status: true,
      disbursementRef: true,
      disbursedAt: true,
      voidedAt: true,
      amendsItemId: true,
      payrollRunId: true,
      payrollRun: { select: { cancelReason: true, notes: true } },
      associate: { select: { firstName: true, lastName: true } },
    },
  });
  return items.map((i) => ({
    itemId: i.id,
    runId: i.payrollRunId,
    associateId: i.associateId,
    associateName: `${i.associate.firstName} ${i.associate.lastName}`,
    checkNumber: (i.disbursementRef ?? '').replace(/^Manual check #/, ''),
    payDate: i.disbursedAt?.toISOString().slice(0, 10) ?? null,
    gross: Number(i.grossPay),
    taxes: round2(Number(i.federalWithholding) + Number(i.fica) + Number(i.medicare) + Number(i.stateWithholding) + Number(i.localWithholding)),
    net: Number(i.netPay),
    status: i.status === 'VOIDED' ? ('VOIDED' as const) : ('RECORDED' as const),
    voidReason: i.payrollRun.cancelReason,
    replacesItemId: i.amendsItemId,
  }));
}

/* ---- Third-party sick pay ------------------------------------------------------- */

export interface SickPayInput {
  associateId: string;
  payerName: string;
  payDate: Date;
  grossAmount: number;
  nontaxableAmount?: number;
  federalWithheld?: number;
  socialSecurityWithheld?: number;
  medicareWithheld?: number;
  stateWithheld?: number;
  employerTaxesBy: 'EMPLOYER' | 'INSURER';
  w2ReportedBy: 'EMPLOYER' | 'INSURER';
  notes?: string | null;
}

/** The employer's share on insurer-paid sick pay, when the insurer passed it back. */
export function sickPayEmployerTaxes(taxable: number, ytdWages: number, state: string | null) {
  return computeEmployerTaxes({ grossPay: Math.max(0, taxable), ytdWages, ytdMedicareWages: ytdWages, state });
}

export async function recordThirdPartySickPay(db: PrismaClient, input: SickPayInput & { actorUserId: string }) {
  if ((input.nontaxableAmount ?? 0) > input.grossAmount) throw new HttpError(400, 'nontaxable_over_gross', 'The nontaxable part can’t be more than the gross.');
  const associate = await db.associate.findFirst({ where: { id: input.associateId, deletedAt: null }, select: { id: true, state: true } });
  if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  const row = await db.thirdPartySickPay.create({
    data: {
      associateId: associate.id,
      payerName: input.payerName,
      payDate: input.payDate,
      grossAmount: round2(input.grossAmount),
      nontaxableAmount: round2(input.nontaxableAmount ?? 0),
      federalWithheld: round2(input.federalWithheld ?? 0),
      socialSecurityWithheld: round2(input.socialSecurityWithheld ?? 0),
      medicareWithheld: round2(input.medicareWithheld ?? 0),
      stateWithheld: round2(input.stateWithheld ?? 0),
      employerTaxesBy: input.employerTaxesBy,
      w2ReportedBy: input.w2ReportedBy,
      notes: input.notes ?? null,
      recordedById: input.actorUserId,
    },
  });
  let employerTaxes = { fica: 0, medicare: 0, futa: 0, suta: 0 };
  if (input.employerTaxesBy === 'EMPLOYER') {
    const taxable = round2(input.grossAmount - (input.nontaxableAmount ?? 0));
    const yearStart = new Date(Date.UTC(input.payDate.getUTCFullYear(), 0, 1));
    const ytd = await computeYtdWages(db, associate.id, yearStart, input.payDate);
    const e = sickPayEmployerTaxes(taxable, ytd, associate.state);
    employerTaxes = { fica: e.fica, medicare: e.medicare, futa: e.futa, suta: e.suta };
    await postSickPayLiabilities(db, row.id, input.payDate, associate.state, employerTaxes).catch((err) =>
      console.warn('[manualChecks] sick pay liability posting failed (advisory):', err),
    );
  }
  await recordCriticalAudit(
    { actorUserId: input.actorUserId, action: 'payroll.third_party_sick_pay.recorded', entityType: 'ThirdPartySickPay', entityId: row.id, metadata: { associateId: associate.id, gross: input.grossAmount, employerTaxesBy: input.employerTaxesBy, w2ReportedBy: input.w2ReportedBy } },
    'manualChecks.sickPay',
  );
  return { row, employerTaxes };
}

async function postSickPayLiabilities(db: PrismaClient, sickPayId: string, payDate: Date, state: string | null, t: { fica: number; medicare: number; futa: number; suta: number }): Promise<void> {
  const { resolveAccount, dueFor } = await import('./payrollTaxLedger.js');
  const { quarterLabel } = await import('./payrollTaxCalendar.js');
  const postings: Array<{ kind: 'FEDERAL_WITHHOLDING' | 'FEDERAL_UNEMPLOYMENT' | 'STATE_UNEMPLOYMENT'; jurisdiction: string; amount: number; breakdown: Record<string, number | string> }> = [];
  const fed = round2(t.fica + t.medicare);
  if (fed > 0) postings.push({ kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', amount: fed, breakdown: { employerSocialSecurity: t.fica, employerMedicare: t.medicare, thirdPartySickPayId: sickPayId } });
  if (t.futa > 0) postings.push({ kind: 'FEDERAL_UNEMPLOYMENT', jurisdiction: 'US', amount: round2(t.futa), breakdown: { futa: t.futa, thirdPartySickPayId: sickPayId } });
  if (t.suta > 0 && state) postings.push({ kind: 'STATE_UNEMPLOYMENT', jurisdiction: state.toUpperCase(), amount: round2(t.suta), breakdown: { unemployment: t.suta, thirdPartySickPayId: sickPayId } });
  for (const p of postings) {
    const account = await resolveAccount(db, null, p.kind, p.jurisdiction);
    await db.taxLiability.create({
      data: {
        tenantId: tenantIdForWrite(),
        payrollRunId: null,
        accountId: account.id,
        kind: p.kind,
        jurisdiction: p.jurisdiction,
        periodLabel: quarterLabel(payDate),
        liabilityDate: payDate,
        dueDate: dueFor(account, payDate, p.amount),
        amount: p.amount,
        breakdown: p.breakdown as Prisma.InputJsonValue,
      },
    });
  }
}

export async function voidThirdPartySickPay(db: PrismaClient, input: { id: string; actorUserId: string }): Promise<void> {
  const row = await db.thirdPartySickPay.findFirst({ where: { id: input.id, voidedAt: null } });
  if (!row) throw new HttpError(404, 'sick_pay_not_found', 'Sick pay record not found');
  await db.thirdPartySickPay.update({ where: { id: row.id }, data: { voidedAt: new Date() } });
  await db.taxLiability.deleteMany({ where: { payrollRunId: null, status: 'OPEN', breakdown: { path: ['thirdPartySickPayId'], equals: row.id } } });
  await recordCriticalAudit(
    { actorUserId: input.actorUserId, action: 'payroll.third_party_sick_pay.voided', entityType: 'ThirdPartySickPay', entityId: row.id, metadata: {} },
    'manualChecks.sickPayVoid',
  );
}
