import type { Prisma, PrismaClient } from '@prisma/client';
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
  const postTaxDeductions: PaystubLine[] =
    Number(item.postTaxDeductions) > 0
      ? [{ label: 'Post-tax deductions', current: Number(item.postTaxDeductions), ytd: ytd.postTax }]
      : [];

  return {
    company: {
      name: client?.legalName || client?.name || 'Alto Etho LLC',
      addressLine1: client?.addressLine1 ?? null,
      city: client?.city ?? null,
      state: client?.state ?? null,
      zip: client?.zip ?? null,
      ein: client?.ein ?? null,
    },
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
