import type { Prisma } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import { postEntry } from '../ledger.js';
import { LineBook, cents, voidByKey, ymd, type Db, type Dims } from './common.js';

/**
 * A payroll run in the books — two entries per run, both idempotent:
 *
 *   payroll-run:<id>            the accrual, dated the period's last day:
 *       Dr wages (direct labor for people working at a client, staff wages
 *          for the company's own; contractor payments for 1099s)
 *       Dr employer taxes and employer benefit/retirement contributions
 *       Dr reimbursements paid in the check
 *       Cr net pay payable, the withheld taxes (FIT, Social Security and
 *          Medicare — both halves —, state, local, state programs, FUTA,
 *          SUTA) and every deduction to its payable (benefits, retirement,
 *          garnishments); van rides to transportation income; wage advances
 *          back against the advance; an overpayment recovery back against
 *          the wages it overpaid.
 *   payroll-run:<id>:disburse   the money leaving: Dr net pay payable,
 *       Cr payroll checking, for the checks actually paid (an ACH return
 *       re-posts it smaller).
 *
 * Lines are summed by account × client × site — never per person. A check
 * whose stored numbers don't tie (gross + reimbursements ≠ net + taxes +
 * deductions) posts the difference to Uncategorized expense, named in the
 * memo, instead of hiding it in net pay. A voided run takes both off.
 */

const BENEFIT_CODES = new Set(['MEDICAL', 'DENTAL', 'VISION', 'HSA', 'HEALTH_FSA', 'DCAP', 'LIFE', 'DISABILITY', 'ER_HEALTH', 'ER_HSA']);
const RETIREMENT_CODES = new Set(['RET_401K', 'RET_403B', 'RET_457B', 'ROTH_401K', 'ROTH_403B', 'RET_LOAN', 'ER_401K_MATCH', 'ER_TRUMP_ACCOUNT']);

/** The payable (or income) a deduction is owed to. */
export function deductionAccount(d: { code: string; sourceType: string | null }, wagesAccount: string): string {
  if (BENEFIT_CODES.has(d.code)) return 'BENEFITS_PAYABLE';
  if (RETIREMENT_CODES.has(d.code)) return 'RETIREMENT_PAYABLE';
  if (d.code === 'GARNISHMENT') return 'GARNISHMENTS_PAYABLE';
  // States let the employer keep a garnishment processing fee.
  if (d.code === 'GARNISHMENT_FEE') return 'OTHER_INCOME';
  if (d.code === 'EWA_RECOVERY') return 'EMPLOYEE_ADVANCES';
  if (d.code === 'RIDES') return 'REVENUE_TRANSPORT';
  // Money paid by mistake comes back against the wages it overpaid.
  if (d.sourceType === 'PendingPayrollDeduction') return wagesAccount;
  return 'DEDUCTIONS_PAYABLE';
}

export const runKey = (runId: string) => `payroll-run:${runId}`;
export const disburseKey = (runId: string) => `payroll-run:${runId}:disburse`;

/** Which client and store each person on the run worked for, as of the period's end. */
async function placements(db: Db, associateIds: string[], on: Date): Promise<Map<string, { clientId: string | null; siteId: string | null; employmentType: string | null }>> {
  const people = await db.associate.findMany({
    where: { id: { in: associateIds } },
    select: {
      id: true,
      employmentType: true,
      assignments: {
        where: { startedAt: { lte: on } },
        orderBy: { startedAt: 'desc' },
        take: 3,
        select: { locationId: true, endedAt: true, location: { select: { clientId: true } } },
      },
      applications: { where: { status: 'APPROVED', deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 1, select: { clientId: true } },
    },
  });
  const out = new Map<string, { clientId: string | null; siteId: string | null; employmentType: string | null }>();
  for (const p of people) {
    // The placement open on the day, else the latest one before it.
    const a = p.assignments.find((x) => !x.endedAt || x.endedAt >= on) ?? p.assignments[0];
    out.set(p.id, {
      clientId: a?.location.clientId ?? p.applications[0]?.clientId ?? null,
      siteId: a?.locationId ?? null,
      employmentType: p.employmentType as string | null,
    });
  }
  return out;
}

export interface RunPostingResult {
  accrual: 'posted' | 'voided' | 'skipped';
  disbursement: 'posted' | 'voided' | 'skipped';
  suspenseCents: number;
}

/** Bring a run's entries in line with what the run is now. Safe to call any number of times. */
export async function postPayrollRun(db: Db, runId: string): Promise<RunPostingResult> {
  const run = await db.payrollRun.findFirst({
    where: { id: runId, tenantId: tenantIdForWrite() },
    include: {
      items: {
        include: {
          taxLines: { select: { kind: true, employer: true, amount: true } },
          deductions: { select: { code: true, category: true, sourceType: true, employeeAmount: true, employerAmount: true } },
        },
      },
    },
  });
  if (!run) return { accrual: 'skipped', disbursement: 'skipped', suspenseCents: 0 };

  if (run.status === 'CANCELLED') {
    await voidByKey(db, disburseKey(run.id), 'The payroll run was voided');
    await voidByKey(db, runKey(run.id), 'The payroll run was voided');
    return { accrual: 'voided', disbursement: 'voided', suspenseCents: 0 };
  }
  // A draft hasn't committed anyone's pay yet.
  if (run.status === 'DRAFT') return { accrual: 'skipped', disbursement: 'skipped', suspenseCents: 0 };

  const items = run.items.filter((i) => i.status !== 'VOIDED');
  const where = await placements(db, items.map((i) => i.associateId), run.periodEnd);
  const book = new LineBook();
  let suspense = 0;

  for (const i of items) {
    const place = where.get(i.associateId) ?? { clientId: null, siteId: null, employmentType: null };
    const clientId = run.clientId ?? place.clientId;
    const dims: Dims = { clientId, siteId: place.siteId };
    const direct = !!clientId;
    const contractor = !!place.employmentType && place.employmentType !== 'W2_EMPLOYEE';
    const wages = contractor ? 'CONTRACTORS_DIRECT' : direct ? 'WAGES_DIRECT' : 'WAGES_INTERNAL';
    const employerTax = direct ? 'EMPLOYER_TAX_DIRECT' : 'EMPLOYER_TAX_INTERNAL';
    const benefitsExpense = direct ? 'BENEFITS_DIRECT' : 'WAGES_INTERNAL';

    const gross = cents(i.grossPay);
    const reimb = cents(i.reimbursementsTotal);
    const net = cents(i.netPay);
    book.debit(wages, gross, dims);
    book.debit('REIMBURSEMENTS', reimb, dims);
    book.credit('NET_PAY_PAYABLE', net, dims);

    // What the check withheld.
    const fit = cents(i.federalWithholding);
    const ssMed = cents(i.fica) + cents(i.medicare);
    const sit = cents(i.stateWithholding);
    const local = cents(i.localWithholding);
    const programEe = i.taxLines.filter((l) => l.kind === 'STATE_PROGRAM' && !l.employer).reduce((s, l) => s + cents(l.amount), 0);
    book.credit('FIT_PAYABLE', fit, dims);
    book.credit('FICA_PAYABLE', ssMed, dims);
    book.credit('SIT_PAYABLE', sit, dims);
    book.credit('LOCAL_TAX_PAYABLE', local, dims);
    book.credit('SUTA_PAYABLE', programEe, dims);

    // What the employer owes on top.
    const erSsMed = cents(i.employerFica) + cents(i.employerMedicare);
    const futa = cents(i.employerFuta);
    const suta = cents(i.employerSuta);
    const erLocal = i.taxLines.filter((l) => l.employer && (l.kind === 'LOCAL' || l.kind === 'EMPLOYER' || l.kind === 'OLT' || l.kind === 'TRANSIT')).reduce((s, l) => s + cents(l.amount), 0);
    const erProgram = i.taxLines.filter((l) => l.employer && l.kind === 'STATE_PROGRAM').reduce((s, l) => s + cents(l.amount), 0);
    book.debit(employerTax, erSsMed + futa + suta + erLocal + erProgram, dims);
    book.credit('FICA_PAYABLE', erSsMed, dims);
    book.credit('FUTA_PAYABLE', futa, dims);
    book.credit('SUTA_PAYABLE', suta + erProgram, dims);
    book.credit('LOCAL_TAX_PAYABLE', erLocal, dims);

    // Deductions, itemized when the check has them; the lump columns otherwise.
    let deducted = 0;
    if (i.deductions.length > 0) {
      for (const d of i.deductions) {
        const ee = cents(d.employeeAmount);
        const er = cents(d.employerAmount);
        const account = deductionAccount(d, wages);
        if (ee) {
          book.credit(account, ee, dims);
          deducted += ee;
        }
        if (er) {
          book.debit(benefitsExpense, er, dims);
          book.credit(account === 'OTHER_INCOME' || account === wages ? 'DEDUCTIONS_PAYABLE' : account, er, dims);
        }
      }
    } else {
      deducted = cents(i.preTaxDeductions) + cents(i.postTaxDeductions);
      book.credit('DEDUCTIONS_PAYABLE', deducted, dims);
    }

    // gross + reimbursements must equal net + withheld taxes + deductions.
    const residue = gross + reimb - (net + fit + ssMed + sit + local + programEe + deducted);
    if (residue !== 0) {
      book.credit('UNCATEGORIZED_EXPENSE', residue, dims, 'Payroll check numbers that don’t tie — review');
      suspense += residue;
    }
  }

  const period = `${ymd(run.periodStart)} – ${ymd(run.periodEnd)}`;
  const kind = run.kind === 'REGULAR' ? 'Payroll' : `${run.kind.charAt(0)}${run.kind.slice(1).toLowerCase().replace(/_/g, ' ')} payroll`;
  let accrual: RunPostingResult['accrual'];
  if (!book.isEmpty()) {
    await postEntry(db, {
      date: ymd(run.periodEnd),
      memo: `${kind} ${period}${suspense ? ` — ${(Math.abs(suspense) / 100).toFixed(2)} that doesn’t tie is in Uncategorized expense` : ''}`,
      source: 'PAYROLL',
      sourceType: 'PayrollRun',
      sourceId: run.id,
      sourceKey: runKey(run.id),
      lines: book.lines(),
    });
    accrual = 'posted';
  } else {
    accrual = (await voidByKey(db, runKey(run.id), 'Nothing left on the run')) > 0 ? 'voided' : 'skipped';
  }

  // The money that left: checks actually paid.
  const paid = items.filter((i) => i.status === 'DISBURSED');
  const paidNet = paid.reduce((s, i) => s + cents(i.netPay), 0);
  let disbursement: RunPostingResult['disbursement'];
  if (paidNet !== 0) {
    const when = run.disbursedAt ?? paid.map((i) => i.disbursedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? new Date();
    const pay = new LineBook();
    for (const i of paid) {
      const place = where.get(i.associateId);
      const dims: Dims = { clientId: run.clientId ?? place?.clientId ?? null, siteId: place?.siteId ?? null };
      pay.debit('NET_PAY_PAYABLE', cents(i.netPay), dims);
      pay.credit('CASH_PAYROLL', cents(i.netPay));
    }
    await postEntry(db, {
      date: ymd(when),
      memo: `${kind} paid ${period} — ${paid.length} ${paid.length === 1 ? 'check' : 'checks'}`,
      source: 'PAYROLL_DISBURSEMENT',
      sourceType: 'PayrollRun',
      sourceId: run.id,
      sourceKey: disburseKey(run.id),
      lines: pay.lines(),
    });
    disbursement = 'posted';
  } else {
    disbursement = (await voidByKey(db, disburseKey(run.id), 'No check on the run was paid')) > 0 ? 'voided' : 'skipped';
  }
  return { accrual, disbursement, suspenseCents: suspense };
}

/** Runs that should be in the books: finalized or paid, or voided after posting. */
export const POSTABLE_RUN: Prisma.PayrollRunWhereInput = { status: { in: ['FINALIZED', 'DISBURSED'] } };
