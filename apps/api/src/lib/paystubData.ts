import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { employerFor } from './employment.js';
import { decryptString } from './crypto.js';
import type { PaystubData, PaystubEarningLine, PaystubLine } from './paystub.js';

/**
 * Single source of truth for turning a PayrollItem into the PaystubData
 * the renderer consumes — used by both the on-demand download route and
 * the email-on-disburse path so the two are always identical. Async
 * because it computes live year-to-date figures (the item only snapshots
 * ytdWages).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const EARNING_LABEL: Record<string, string> = {
  REGULAR: 'Regular',
  OVERTIME: 'Overtime',
  DOUBLE_TIME: 'Double time / premium',
  HOLIDAY: 'Holiday',
  SICK: 'Sick',
  VACATION: 'Vacation / PTO',
  BONUS: 'Bonus',
  COMMISSION: 'Commission',
  TIPS: 'Tips',
  REIMBURSEMENT: 'Reimbursement',
  RETRO: 'Retroactive pay',
};

const ITEM_INCLUDE = {
  payrollRun: {
    include: {
      client: {
        select: {
          name: true,
          legalName: true,
          ein: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
        },
      },
    },
  },
  associate: {
    include: { payoutMethods: { where: { isPrimary: true }, take: 1 } },
  },
  earnings: true,
} satisfies Prisma.PayrollItemInclude;

export type PaystubItem = Prisma.PayrollItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

export function paystubItemInclude() {
  return ITEM_INCLUDE;
}

/**
 * Year-to-date through this check: prior DISBURSED items in non-cancelled
 * runs whose period starts before this run's, plus this item itself.
 * Mirrors payrollYtd.ts's inclusion rules (AMENDMENT signed deltas sum
 * naturally; voided/pending excluded) so the stub reconciles with the
 * engine.
 */
type PrismaLike = Pick<PrismaClient, 'payrollItem'>;

export async function computePaystubYtd(
  prisma: PrismaLike,
  item: PaystubItem,
): Promise<Record<string, number>> {
  const year = item.payrollRun.periodStart.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const prior = await prisma.payrollItem.aggregate({
    where: {
      associateId: item.associateId,
      status: 'DISBURSED',
      id: { not: item.id },
      payrollRun: {
        status: { not: 'CANCELLED' },
        periodStart: { gte: yearStart, lt: item.payrollRun.periodStart },
      },
    },
    _sum: {
      grossPay: true,
      federalWithholding: true,
      fica: true,
      medicare: true,
      stateWithholding: true,
      localWithholding: true,
      preTaxDeductions: true,
      postTaxDeductions: true,
      reimbursementsTotal: true,
      netPay: true,
      rideChargesCents: true,
    },
  });
  const s = prior._sum;
  const add = (priorVal: Prisma.Decimal | null, thisVal: Prisma.Decimal) =>
    round2(Number(priorVal ?? 0) + Number(thisVal));
  return {
    gross: add(s.grossPay, item.grossPay),
    fit: add(s.federalWithholding, item.federalWithholding),
    ss: add(s.fica, item.fica),
    medicare: add(s.medicare, item.medicare),
    state: add(s.stateWithholding, item.stateWithholding),
    local: add(s.localWithholding, item.localWithholding),
    preTax: add(s.preTaxDeductions, item.preTaxDeductions),
    postTax: add(s.postTaxDeductions, item.postTaxDeductions),
    rides: round2(((s.rideChargesCents ?? 0) + item.rideChargesCents) / 100),
    reimb: add(s.reimbursementsTotal, item.reimbursementsTotal),
    net: add(s.netPay, item.netPay),
  };
}

function earningLines(item: PaystubItem): PaystubEarningLine[] {
  // Use the per-kind breakdown, excluding REIMBURSEMENT (shown separately
  // as non-taxable). Fall back to a single synthesized line for older
  // items with no earning rows.
  const taxable = item.earnings.filter((e) => e.kind !== 'REIMBURSEMENT');
  if (taxable.length > 0) {
    return taxable.map((e) => ({
      label: e.notes?.trim() || EARNING_LABEL[e.kind] || e.kind,
      hours: e.hours != null ? Number(e.hours) : null,
      rate: e.rate != null ? Number(e.rate) : null,
      amount: round2(Number(e.amount)),
    }));
  }
  const reimb = Number(item.reimbursementsTotal);
  return [
    {
      label: 'Regular',
      hours: Number(item.hoursWorked) || null,
      rate: Number(item.hourlyRate) || null,
      amount: round2(Number(item.grossPay) - (reimb > 0 ? 0 : 0)),
    },
  ];
}

function payDistribution(item: PaystubItem): PaystubData['payDistribution'] {
  // A deposit the bank returned and the re-send that followed: the stub
  // says so, in the person's own words of where the money went.
  const reroute = (item as { rerouteDetail?: unknown }).rerouteDetail as
    | { returnedAt: string; returnedReason: string; reroutedAt: string; to: string }
    | null
    | undefined;
  if (reroute?.to) {
    return {
      label: `Re-sent to ${reroute.to}`,
      detail: `The original deposit was returned on ${reroute.returnedAt.slice(0, 10)} (${reroute.returnedReason}) and re-sent on ${reroute.reroutedAt.slice(0, 10)}.`,
    };
  }
  const pm = item.associate.payoutMethods[0];
  if (!pm) return undefined;
  if (pm.branchCardId) return { label: 'Branch card', detail: 'Loaded to your Branch card' };
  if (pm.accountNumberEnc) {
    let last4 = '';
    try {
      last4 = decryptString(pm.accountNumberEnc).slice(-4);
    } catch {
      /* leave blank if the key rotated */
    }
    const type = pm.accountType === 'SAVINGS' ? 'savings' : 'checking';
    return {
      label: 'Direct deposit',
      detail: `${type[0].toUpperCase()}${type.slice(1)} account${last4 ? ` ending ${last4}` : ''}`,
    };
  }
  return undefined;
}

export async function buildPaystubDataFromItem(
  prisma: PrismaLike,
  item: PaystubItem,
  issuedAt: Date = new Date(),
): Promise<PaystubData> {
  const ytd = await computePaystubYtd(prisma, item);
  const client = item.payrollRun.client;
  const stateLabel = item.taxState ? `${item.taxState} state income tax` : 'State income tax';

  const taxes: PaystubLine[] = [
    { label: 'Federal income tax', current: Number(item.federalWithholding), ytd: ytd.fit },
    { label: 'Social Security', current: Number(item.fica), ytd: ytd.ss },
    { label: 'Medicare', current: Number(item.medicare), ytd: ytd.medicare },
    { label: stateLabel, current: Number(item.stateWithholding), ytd: ytd.state },
  ];
  if (Number(item.localWithholding) > 0) {
    taxes.push({ label: 'Local income tax', current: Number(item.localWithholding), ytd: ytd.local });
  }
  const taxesCurrent = round2(taxes.reduce((a, t) => a + t.current, 0));

  const preTaxDeductions: PaystubLine[] =
    Number(item.preTaxDeductions) > 0
      ? [{ label: 'Health & benefits', current: Number(item.preTaxDeductions), ytd: ytd.preTax }]
      : [];
  // Brief 1A-3: van ride charges are their own line — what this check
  // took, and when the minimum-wage guard held part back, the statement
  // says so in the label. Other post-tax deductions keep their line.
  const rideCurrent = round2(item.rideChargesCents / 100);
  const rideDeferred = round2(item.rideChargesDeferredCents / 100);
  const guard = (item.rideChargeGuard ?? null) as { minimumWageCents?: number; state?: string } | null;
  const otherPostTax = round2(Number(item.postTaxDeductions) - rideCurrent);
  const postTaxDeductions: PaystubLine[] = [];
  if (rideCurrent > 0 || rideDeferred > 0) {
    const guardNote =
      rideDeferred > 0 && guard?.minimumWageCents
        ? ` — $${rideDeferred.toFixed(2)} carried to a later check so pay stays at the ${guard.state && guard.state !== 'FEDERAL' ? guard.state + ' ' : ''}minimum wage of $${(guard.minimumWageCents / 100).toFixed(2)}/h`
        : '';
    postTaxDeductions.push({ label: `Van rides${guardNote}`, current: rideCurrent, ytd: ytd.rides });
  }
  // Earned-wage advances this check recovered get their own line; the
  // rest of the post-tax bucket keeps its generic one.
  const ewaRows = await defaultPrisma.earnedWageAdvance.findMany({
    where: { associateId: item.associateId, recoveryLog: { array_contains: [{ runId: item.payrollRunId }] } },
    select: { recoveryLog: true },
  });
  const ewaCurrent = round2(
    ewaRows.reduce((s, r) => {
      const log = Array.isArray(r.recoveryLog) ? (r.recoveryLog as Array<{ runId: string; cents: number }>) : [];
      return s + log.filter((l) => l.runId === item.payrollRunId).reduce((x, l) => x + l.cents, 0) / 100;
    }, 0),
  );
  if (ewaCurrent > 0) {
    postTaxDeductions.push({ label: 'Earned-wage advance repaid', current: ewaCurrent, ytd: ewaCurrent });
  }
  const remainingPostTax = round2(otherPostTax - ewaCurrent);
  if (remainingPostTax > 0) {
    postTaxDeductions.push({ label: 'Post-tax deductions', current: remainingPostTax, ytd: round2(ytd.postTax - ytd.rides - ewaCurrent) });
  }

  // Brief 2-1b: the company block is the employer of record. A client that
  // carries no legal facts of its own keeps its name on the stub, as before.
  const employer = await employerFor(defaultPrisma, item.associateId, item.payrollRun.periodEnd);
  const company =
    employer.kind !== 'TENANT' || !client
      ? { name: employer.legalName, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip, ein: employer.ein }
      : { name: client.legalName || client.name, addressLine1: client.addressLine1 ?? null, city: client.city ?? null, state: client.state ?? null, zip: client.zip ?? null, ein: client.ein ?? null };
  return {
    company,
    associate: {
      firstName: item.associate.firstName,
      lastName: item.associate.lastName,
      email: item.associate.email,
      addressLine1: item.associate.addressLine1,
      city: item.associate.city,
      state: item.associate.state,
      zip: item.associate.zip,
      employeeId: item.associateId.slice(0, 8).toUpperCase(),
    },
    period: {
      start: ymd(item.payrollRun.periodStart),
      end: ymd(item.payrollRun.periodEnd),
      payDate: item.payrollRun.disbursedAt ? ymd(item.payrollRun.disbursedAt) : null,
    },
    earnings: earningLines(item),
    gross: { current: Number(item.grossPay), ytd: ytd.gross },
    taxes,
    taxesTotal: { current: taxesCurrent, ytd: round2(taxes.reduce((a, t) => a + t.ytd, 0)) },
    preTaxDeductions,
    postTaxDeductions,
    ...(Number(item.reimbursementsTotal) > 0
      ? { reimbursements: { current: Number(item.reimbursementsTotal), ytd: ytd.reimb } }
      : {}),
    net: { current: Number(item.netPay), ytd: ytd.net },
    employer: {
      fica: Number(item.employerFica),
      medicare: Number(item.employerMedicare),
      futa: Number(item.employerFuta),
      suta: Number(item.employerSuta),
    },
    payDistribution: payDistribution(item),
    meta: { runId: item.payrollRunId, itemId: item.id, issuedAt: issuedAt.toISOString() },
    ...(item.payrollRun.kind === 'AMENDMENT' && item.payrollRun.amendsRunId
      ? { amendment: { reason: item.payrollRun.amendmentReason ?? '', sourceRunId: item.payrollRun.amendsRunId } }
      : {}),
    ...(item.payrollRun.status === 'CANCELLED' || item.status === 'VOIDED'
      ? {
          voided: {
            voidedAt: (item.payrollRun.cancelledAt ?? item.voidedAt ?? new Date()).toISOString(),
            reason: item.payrollRun.cancelReason,
          },
        }
      : {}),
  };
}

/** Load the item with the full include and build its PaystubData. */
export async function buildPaystubDataById(
  prisma: Pick<PrismaClient, 'payrollItem'>,
  itemId: string,
  issuedAt: Date = new Date(),
): Promise<{ item: PaystubItem; data: PaystubData } | null> {
  const item = await prisma.payrollItem.findUnique({
    where: { id: itemId },
    include: ITEM_INCLUDE,
  });
  if (!item) return null;
  return { item, data: await buildPaystubDataFromItem(prisma, item, issuedAt) };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
