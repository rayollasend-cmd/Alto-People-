import type { Prisma, PrismaClient } from '@prisma/client';
import { bankingProfile, ownAccount, usesOurAch } from './banking/ach.js';
import { periodContaining, ymd, type ScheduleWithVersions } from './payScheduleMembership.js';
import { currentFingerprint, reviewRequired } from './payrollReview.js';
import { fmtDay } from './humanDates.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * One lifecycle for a payroll run, read the same way by the run list, the
 * run drawer and the guided close (finance walk 10): draft → finalized →
 * signed off → funded → disbursed → tax deposit → closed. `nextStep` names
 * what the run waits on now and where to do it; `waitingOn` says when the
 * move is someone else's (a second approver, the bank).
 */
export type NextStepKey = 'finalize' | 'review' | 'fund' | 'held' | 'disburse' | 'uploadFile' | 'deposit' | 'remit' | 'done' | 'cancelled';

export interface NextStep {
  key: NextStepKey;
  label: string;
  to: string;
  waitingOn: string | null;
}

export interface RunLifecycle {
  nextStep: NextStep;
  payDate: string | null;
  reviewSignedAt: string | null;
}

interface RunRow {
  id: string;
  status: 'DRAFT' | 'FINALIZED' | 'DISBURSED' | 'CANCELLED';
  kind: 'REGULAR' | 'OFF_CYCLE' | 'AMENDMENT' | 'DAILY' | 'MANUAL';
  periodStart: Date;
  periodEnd: Date;
  payrollScheduleId: string | null;
}

const FUNDED = new Set(['SETTLED', 'WIRE_RECEIVED']);

export async function lifecycleForRuns(db: Db, runs: RunRow[]): Promise<Map<string, RunLifecycle>> {
  const out = new Map<string, RunLifecycle>();
  if (runs.length === 0) return out;
  const ids = runs.map((r) => r.id);
  const scheduleIds = [...new Set(runs.map((r) => r.payrollScheduleId).filter((x): x is string => !!x))];
  const finalized = runs.filter((r) => r.status === 'FINALIZED');
  const disbursed = runs.filter((r) => r.status === 'DISBURSED');

  const [profile, schedules, reviews, fundings, held, files, deposits, remittances] = await Promise.all([
    bankingProfile(db),
    scheduleIds.length
      ? db.payrollSchedule.findMany({ where: { id: { in: scheduleIds } }, select: { id: true, name: true, frequency: true, anchorDate: true, payDateOffsetDays: true, versions: true } })
      : Promise.resolve([] as Array<ScheduleWithVersions & { id: string }>),
    db.payrollRunReview.findMany({ where: { payrollRunId: { in: ids } }, orderBy: { signedAt: 'desc' }, select: { payrollRunId: true, fingerprint: true, signedAt: true } }),
    finalized.length ? db.payrollFunding.findMany({ where: { payrollRunId: { in: finalized.map((r) => r.id) } }, select: { payrollRunId: true, status: true } }) : Promise.resolve([]),
    finalized.length
      ? db.payrollItem.groupBy({ by: ['payrollRunId'], where: { payrollRunId: { in: finalized.map((r) => r.id) }, status: { in: ['HELD', 'FAILED'] } }, _count: { _all: true } })
      : Promise.resolve([] as Array<{ payrollRunId: string; _count: { _all: number } }>),
    finalized.length
      ? db.achFile.findMany({ where: { payrollRunId: { in: finalized.map((r) => r.id) }, purpose: 'DIRECT_DEPOSIT', provider: 'IN_HOUSE', status: { in: ['CREATED', 'DOWNLOADED'] } }, select: { payrollRunId: true } })
      : Promise.resolve([]),
    disbursed.length ? db.taxDeposit.findMany({ where: { payrollRunId: { in: disbursed.map((r) => r.id) } }, select: { payrollRunId: true, status: true, dueDate: true } }) : Promise.resolve([]),
    disbursed.length ? db.garnishmentRemittance.findMany({ where: { payrollRunId: { in: disbursed.map((r) => r.id) }, status: { not: 'SENT' } }, select: { payrollRunId: true } }) : Promise.resolve([]),
  ]);
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));
  const latestReview = new Map<string, { fingerprint: string; signedAt: Date }>();
  for (const r of reviews) if (!latestReview.has(r.payrollRunId)) latestReview.set(r.payrollRunId, r);
  const fundingByRun = new Map(fundings.map((f) => [f.payrollRunId, f.status]));
  const heldByRun = new Map(held.map((h) => [h.payrollRunId, h._count._all]));
  const fileWaiting = new Set(files.map((f) => f.payrollRunId));
  const depositByRun = new Map(deposits.map((d) => [d.payrollRunId, d]));
  const remitOpen = new Set(remittances.map((r) => r.payrollRunId));
  const ourAch = usesOurAch(profile);
  const own = ownAccount(profile);

  for (const run of runs) {
    const schedule = run.payrollScheduleId ? scheduleById.get(run.payrollScheduleId) : undefined;
    const payDate = schedule ? periodContaining(schedule, ymd(run.periodStart)).payDate : null;
    const runPath = `/payroll?run=${run.id}`;
    let reviewSignedAt: string | null = null;
    let nextStep: NextStep;
    if (run.status === 'CANCELLED') {
      nextStep = { key: 'cancelled', label: 'Voided', to: runPath, waitingOn: null };
    } else if (run.status === 'DRAFT') {
      nextStep = { key: 'finalize', label: 'Finalize', to: runPath, waitingOn: null };
    } else {
      // Signed off on the current numbers?
      const required = await reviewRequired(db, run);
      const latest = latestReview.get(run.id);
      if (required && latest && latest.fingerprint === (await currentFingerprint(db, run.id))) reviewSignedAt = latest.signedAt.toISOString();
      if (run.status === 'FINALIZED') {
        const heldCount = heldByRun.get(run.id) ?? 0;
        const fundingStatus = fundingByRun.get(run.id) ?? null;
        if (required && !reviewSignedAt) {
          nextStep = { key: 'review', label: latest ? 'Review again and sign off' : 'Review and sign off', to: `/payroll/runs/${run.id}/review`, waitingOn: 'a second person' };
        } else if (ourAch && !own && (!fundingStatus || !FUNDED.has(fundingStatus))) {
          const waiting = fundingStatus === 'SUBMITTED' ? 'the bank' : fundingStatus === 'AWAITING_APPROVAL' ? 'a second approver' : fundingStatus === 'WIRE_PENDING' ? 'the wire' : null;
          nextStep = { key: 'fund', label: fundingStatus === 'RETURNED' ? 'Fund again — the debit came back' : fundingStatus ? 'Funding on its way' : 'Fund the run', to: '/payroll/banking', waitingOn: waiting };
        } else if (fileWaiting.has(run.id)) {
          nextStep = { key: 'uploadFile', label: 'Upload the bank file, then mark it uploaded', to: '/payroll/banking?tab=files', waitingOn: null };
        } else if (heldCount > 0) {
          nextStep = { key: 'held', label: `Clear ${heldCount} held paycheck${heldCount === 1 ? '' : 's'}`, to: runPath, waitingOn: null };
        } else {
          nextStep = { key: 'disburse', label: 'Disburse', to: runPath, waitingOn: null };
        }
      } else {
        const deposit = depositByRun.get(run.id);
        if (!deposit) nextStep = { key: 'deposit', label: 'Create the tax deposit', to: `/payroll/runs/${run.id}/close`, waitingOn: null };
        else if (deposit.status !== 'PAID') nextStep = { key: 'deposit', label: `Pay the tax deposit (due ${fmtDay(ymd(deposit.dueDate))})`, to: `/payroll/runs/${run.id}/close`, waitingOn: null };
        else if (remitOpen.has(run.id)) nextStep = { key: 'remit', label: 'Send garnishment remittances', to: `/payroll/runs/${run.id}/close`, waitingOn: null };
        else nextStep = { key: 'done', label: 'Closed', to: `/payroll/runs/${run.id}/close`, waitingOn: null };
      }
    }
    out.set(run.id, { nextStep, payDate, reviewSignedAt });
  }
  return out;
}
