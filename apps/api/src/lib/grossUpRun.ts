import { Prisma, type PayrollEarningKind, type PrismaClient, type W4FilingStatus } from '@prisma/client';
import { solveGrossUp, type GrossUpBreakdown } from './grossUp.js';
import type { PayFrequency } from './payrollTax.js';

/**
 * Gross-up on a real run: quote the gross with the statutory supplemental
 * method (lib/grossUp), add the line, then check the paycheck the run
 * actually builds — its tax engine, the person's 401(k) election, the
 * other wages on the same check — and correct the line until the bonus
 * adds exactly the take-home asked for. The breakdown shown is what the
 * check really withholds for the bonus, not an estimate.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface GrossUpContext {
  state: string | null;
  payFrequency: PayFrequency;
  filingStatus: W4FilingStatus | null;
  ytdWages: number;
  ytdSupplementalWages: number;
  regularPeriodGross: number;
  /** The person's elected pre-tax 401(k) percent (0.05 = 5%), 0 without one. */
  electedPreTaxPercent: number;
  localRate: number;
}

export async function grossUpContext(db: Db, associateId: string, opts: { runId?: string | null; asOf?: Date } = {}): Promise<GrossUpContext> {
  const asOf = opts.asOf ?? new Date();
  const yearStart = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  const [a, ytd, supp, item, election] = await Promise.all([
    db.associate.findUnique({
      where: { id: associateId },
      select: {
        state: true,
        payrollSchedule: { select: { frequency: true } },
        w4Submission: { select: { filingStatus: true } },
        localTaxRule: { select: { rate: true, isActive: true } },
      },
    }),
    db.payrollItem.aggregate({
      where: { associateId, status: 'DISBURSED', payrollRun: { status: { not: 'CANCELLED' }, periodStart: { gte: yearStart } } },
      _sum: { grossPay: true },
    }),
    db.payrollItemEarning.aggregate({
      where: {
        kind: { in: ['BONUS', 'COMMISSION'] },
        payrollItem: { associateId, status: 'DISBURSED', payrollRun: { status: { not: 'CANCELLED' }, periodStart: { gte: yearStart } } },
      },
      _sum: { amount: true },
    }),
    opts.runId
      ? db.payrollItem.findUnique({ where: { payrollRunId_associateId: { payrollRunId: opts.runId, associateId } }, select: { grossPay: true, earnings: { select: { kind: true, amount: true } } } })
      : Promise.resolve(null),
    // The 401(k) rate lives on the person's benefits enrollment (the one deferral election, lib/retirement).
    db.benefitsEnrollment
      .findFirst({ where: { associateId, electedPercent: { not: null }, rothElection: false, effectiveDate: { lte: new Date() }, OR: [{ terminationDate: null }, { terminationDate: { gte: new Date() } }] }, orderBy: { effectiveDate: 'desc' }, select: { electedPercent: true } })
      .catch(() => null),
  ]);
  const freq = a?.payrollSchedule?.frequency ?? 'BIWEEKLY';
  // Wages already on this check (excluding any bonus lines) share the
  // check's Social Security room and the state's aggregate method.
  const regularOnCheck = item
    ? round2(item.earnings.filter((e) => e.kind !== 'BONUS' && e.kind !== 'COMMISSION').reduce((s, e) => s + Number(e.amount), 0))
    : 0;
  return {
    state: a?.state ?? null,
    payFrequency: freq === 'DAILY' ? 'WEEKLY' : freq,
    filingStatus: a?.w4Submission?.filingStatus ?? null,
    ytdWages: round2(Number(ytd._sum.grossPay ?? 0) + regularOnCheck),
    ytdSupplementalWages: round2(Number(supp._sum.amount ?? 0)),
    regularPeriodGross: regularOnCheck,
    electedPreTaxPercent: election?.electedPercent != null ? Number(election.electedPercent) / 100 : 0,
    localRate: a?.localTaxRule?.isActive ? Number(a.localTaxRule.rate) : 0,
  };
}

export async function quoteGrossUp(
  db: Db,
  input: { associateId: string; targetNet: number; includePreTax: boolean; runId?: string | null },
): Promise<{ breakdown: GrossUpBreakdown; context: GrossUpContext }> {
  const context = await grossUpContext(db, input.associateId, { runId: input.runId });
  const breakdown = solveGrossUp({
    targetNet: input.targetNet,
    state: context.state,
    payFrequency: context.payFrequency,
    filingStatus: context.filingStatus,
    ytdWages: context.ytdWages,
    ytdSupplementalWages: context.ytdSupplementalWages,
    regularPeriodGross: context.regularPeriodGross,
    preTaxPercent: input.includePreTax ? context.electedPreTaxPercent : 0,
    localRate: context.localRate,
  });
  return { breakdown, context };
}

type ItemTaxes = { grossPay: number; preTax: number; federal: number; fica: number; medicare: number; state: number; local: number };

async function itemTaxes(db: Db, runId: string, associateId: string): Promise<ItemTaxes> {
  const i = await db.payrollItem.findUnique({ where: { payrollRunId_associateId: { payrollRunId: runId, associateId } } });
  if (!i) return { grossPay: 0, preTax: 0, federal: 0, fica: 0, medicare: 0, state: 0, local: 0 };
  return {
    grossPay: Number(i.grossPay),
    preTax: Number(i.preTaxDeductions),
    federal: Number(i.federalWithholding),
    fica: Number(i.fica),
    medicare: Number(i.medicare),
    state: Number(i.stateWithholding),
    local: Number(i.localWithholding),
  };
}

const takeHome = (t: ItemTaxes, includePreTax: boolean) =>
  round2(t.grossPay - (includePreTax ? t.preTax : 0) - t.federal - t.fica - t.medicare - t.state - t.local);

export interface StoredGrossUp extends GrossUpBreakdown {
  includePreTax: boolean;
  quotedGross: number;
  /** Corrections against the real check (0 = the quote was exact). */
  corrections: number;
}

/**
 * Add a grossed-up line to a DRAFT run and leave the run aggregated.
 * `reaggregate` is the run's own aggregate-and-persist step.
 */
export async function addGrossedUpAddOn(
  db: PrismaClient,
  input: {
    run: { id: string };
    associateId: string;
    kind: PayrollEarningKind;
    targetNet: number;
    includePreTax: boolean;
    note: string | null;
    actorUserId: string;
    reaggregate: () => Promise<void>;
  },
): Promise<{ addOnId: string; grossUp: StoredGrossUp }> {
  const target = round2(input.targetNet);
  const { breakdown: quote } = await quoteGrossUp(db, { associateId: input.associateId, targetNet: target, includePreTax: input.includePreTax, runId: input.run.id });
  const before = await itemTaxes(db, input.run.id, input.associateId);
  const addOn = await db.payrollRunAddOn.create({
    data: {
      payrollRunId: input.run.id,
      associateId: input.associateId,
      kind: input.kind,
      amount: quote.gross,
      targetNet: target,
      note: input.note,
      createdById: input.actorUserId,
    },
  });
  let gross = quote.gross;
  let after = before;
  let corrections = 0;
  for (let i = 0; i < 6; i++) {
    await input.reaggregate();
    after = await itemTaxes(db, input.run.id, input.associateId);
    const got = round2(takeHome(after, input.includePreTax) - takeHome(before, input.includePreTax));
    const diff = round2(target - got);
    if ((diff <= 0 && diff > -0.02) || i === 5) break;
    // Step by the shortfall over this check's take-home share of a dollar.
    const share = gross > 0 && got > 0 ? got / gross : 0.6;
    gross = round2(Math.max(0.01, gross + diff / share + (diff > 0 ? 0.01 : 0)));
    corrections += 1;
    await db.payrollRunAddOn.update({ where: { id: addOn.id }, data: { amount: gross } });
  }
  const d = (k: keyof ItemTaxes) => round2(after[k] - before[k]);
  const grossUp: StoredGrossUp = {
    targetNet: target,
    gross,
    preTax: d('preTax'),
    federal: d('federal'),
    socialSecurity: d('fica'),
    medicare: d('medicare'),
    state: d('state'),
    local: d('local'),
    net: round2(takeHome(after, input.includePreTax) - takeHome(before, input.includePreTax)),
    stateMethod: quote.stateMethod,
    federalMethod: quote.federalMethod,
    includePreTax: input.includePreTax,
    quotedGross: quote.gross,
    corrections,
  };
  await db.payrollRunAddOn.update({ where: { id: addOn.id }, data: { amount: gross, grossUp: grossUp as unknown as Prisma.InputJsonValue } });
  return { addOnId: addOn.id, grossUp };
}
