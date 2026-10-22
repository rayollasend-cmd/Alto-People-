import { Prisma, type PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { nextPaydayFor, payScheduleFor } from './associatePayday.js';
import { enqueueAudit } from './audit.js';
import { dailyPaidInWindow } from './dailyPay.js';
import { dueAtFor, targetHoursFor } from './hrCaseSla.js';
import { ADMIN_EMAIL_HR_ONLY, notifyAllAdmins, notifyManager } from './notify.js';
import { payableMs } from './payroll.js';
import { splitHours } from './laborRules/hours.js';
import { loadPayContext } from './laborRules/payContext.js';
import { computePaycheckTaxes, type PayFrequency } from './payrollTax.js';
import { computeYtdWages } from './payrollYtd.js';
import { submitCorrection } from './timeCorrections.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * "Check my pay before payday" (PAYEXP §4, Paycom Beti style).
 *
 *   Two days before each pay date the worker sees the check that's coming:
 *   each day's hours, the pay lines, taxes and deductions, and the take-
 *   home. They confirm it ("Looks right") or flag a line. A wrong day with
 *   the right times goes to their lead as a punch correction; anything else
 *   (or a day already locked for payroll) opens a payroll HR case. Payroll
 *   sees who confirmed and the open flags as a blocker on the guided close.
 *
 *   The numbers come from the run itself when payroll has built it, else
 *   an estimate from approved time — and the screen says which.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** How many days before the pay date the preview opens. */
export const PREVIEW_DAYS_BEFORE = 2;

export type FlagKind = 'HOURS' | 'MISSING_DAY' | 'RATE' | 'TAX' | 'DEDUCTION' | 'OTHER';

export interface PreviewFlag {
  line: string;
  kind: FlagKind;
  note: string;
  at: string;
  caseId?: string | null;
  correctionId?: string | null;
}

export interface PayPreview {
  available: boolean;
  /** Why there's nothing to show: no pay schedule, or the window isn't open yet. */
  reason: 'NO_SCHEDULE' | 'NOT_YET' | null;
  payDate: string | null;
  opensOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  source: 'RUN' | 'ESTIMATE';
  days: Array<{ date: string; hours: number; entries: Array<{ id: string; clockInAt: string; clockOutAt: string | null; siteName: string | null; approved: boolean }> }>;
  earnings: Array<{ line: string; kind: string; hours: number | null; rate: number | null; amount: number }>;
  gross: number;
  taxes: Array<{ line: string; kind: 'FEDERAL' | 'SOCIAL_SECURITY' | 'MEDICARE' | 'STATE' | 'LOCAL'; amount: number }>;
  deductions: Array<{ line: string; kind: 'PRE_TAX' | 'POST_TAX'; amount: number }>;
  /** Paid ahead this period: daily pay already sent. */
  paidAhead: number;
  net: number;
  check: { status: 'CONFIRMED' | 'FLAGGED'; flags: PreviewFlag[]; at: string } | null;
}

const EMPTY = (reason: PayPreview['reason'], extra: Partial<PayPreview> = {}): PayPreview => ({
  available: false,
  reason,
  payDate: null,
  opensOn: null,
  periodStart: null,
  periodEnd: null,
  source: 'ESTIMATE',
  days: [],
  earnings: [],
  gross: 0,
  taxes: [],
  deductions: [],
  paidAhead: 0,
  net: 0,
  check: null,
  ...extra,
});

/** The preview for one worker, as of `now`. `force` opens it early (payroll's view of what the worker will see). */
export async function buildPayPreview(db: PrismaClient, associateId: string, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<PayPreview> {
  const next = await nextPaydayFor(associateId, now);
  if (!next) return EMPTY('NO_SCHEDULE');
  const opensOn = ymd(new Date(asDate(next.payDate).getTime() - PREVIEW_DAYS_BEFORE * DAY));
  const window = { payDate: next.payDate, opensOn, periodStart: next.periodStart, periodEnd: next.periodEnd };
  const today = ymd(now);
  if (today < opensOn && !opts.force) return EMPTY('NOT_YET', window);

  const periodStart = asDate(next.periodStart);
  const periodEndExclusive = new Date(asDate(next.periodEnd).getTime() + DAY);
  const [entries, item, check, comp, schedule] = await Promise.all([
    db.timeEntry.findMany({
      where: { associateId, clockInAt: { gte: periodStart, lt: periodEndExclusive }, status: { in: ['APPROVED', 'COMPLETED'] } },
      select: { id: true, locationId: true, clockInAt: true, clockOutAt: true, status: true, breaks: { select: { type: true, startedAt: true, endedAt: true } }, location: { select: { id: true, name: true, state: true, city: true, timezone: true } } },
      orderBy: { clockInAt: 'asc' },
    }),
    db.payrollItem.findFirst({
      where: {
        associateId,
        status: { not: 'VOIDED' },
        payrollRun: { kind: 'REGULAR', status: { not: 'CANCELLED' }, periodStart, periodEnd: asDate(next.periodEnd) },
      },
      include: { earnings: true },
      orderBy: { createdAt: 'desc' },
    }),
    db.payPreviewCheck.findUnique({ where: { associateId_payDate: { associateId, payDate: asDate(next.payDate) } } }),
    db.compensationRecord.findFirst({ where: { associateId, effectiveTo: null, payType: 'HOURLY' }, orderBy: { effectiveFrom: 'desc' }, select: { amount: true } }),
    payScheduleFor(associateId),
  ]);

  const byDay = new Map<string, PayPreview['days'][number]>();
  for (const e of entries) {
    const key = ymd(e.clockInAt);
    const d = byDay.get(key) ?? { date: key, hours: 0, entries: [] };
    if (e.status === 'APPROVED') d.hours = round2(d.hours + payableMs({ status: e.status, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks }) / 3_600_000);
    d.entries.push({ id: e.id, clockInAt: e.clockInAt.toISOString(), clockOutAt: e.clockOutAt?.toISOString() ?? null, siteName: e.location?.name ?? null, approved: e.status === 'APPROVED' });
    byDay.set(key, d);
  }
  const days = [...byDay.values()];
  const daily = await dailyPaidInWindow(db, associateId, periodStart, periodEndExclusive);

  let earnings: PayPreview['earnings'];
  let taxes: PayPreview['taxes'];
  let deductions: PayPreview['deductions'];
  let gross: number;
  let net: number;
  let source: PayPreview['source'];
  if (item) {
    source = 'RUN';
    // The true-up already took daily pay off; show it as the line it is.
    earnings = item.earnings.map((e, i) => ({ line: `earning:${e.kind}:${i}`, kind: e.kind, hours: e.hours !== null ? Number(e.hours) : null, rate: e.rate !== null ? Number(e.rate) : null, amount: Number(e.amount) }));
    gross = Number(item.grossPay);
    taxes = [
      { line: 'tax:FEDERAL', kind: 'FEDERAL' as const, amount: Number(item.federalWithholding) },
      { line: 'tax:SOCIAL_SECURITY', kind: 'SOCIAL_SECURITY' as const, amount: Number(item.fica) },
      { line: 'tax:MEDICARE', kind: 'MEDICARE' as const, amount: Number(item.medicare) },
      { line: 'tax:STATE', kind: 'STATE' as const, amount: Number(item.stateWithholding) },
      { line: 'tax:LOCAL', kind: 'LOCAL' as const, amount: Number(item.localWithholding) },
    ].filter((t) => t.amount !== 0);
    deductions = [
      { line: 'deduction:PRE_TAX', kind: 'PRE_TAX' as const, amount: Number(item.preTaxDeductions) },
      { line: 'deduction:POST_TAX', kind: 'POST_TAX' as const, amount: Number(item.postTaxDeductions) },
    ].filter((d) => d.amount !== 0);
    net = Number(item.netPay);
  } else {
    source = 'ESTIMATE';
    const rate = comp ? Number(comp.amount) : 0;
    // The approved hours split exactly as the run will split them (the
    // labor-rules engine, lib/laborRules/hours): the weekly 40 at 1.5×,
    // plus a live jurisdiction's daily overtime and double time.
    const pay = await loadPayContext(db);
    const split = splitHours(
      pay.rules,
      entries
        .filter((e) => e.status === 'APPROVED')
        .map((raw) => {
          const e = pay.forPay(raw);
          return { id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location };
        }),
    );
    earnings = [];
    if (split.regularHours > 0) earnings.push({ line: 'earning:REGULAR:0', kind: 'REGULAR', hours: split.regularHours, rate, amount: round2(split.regularHours * rate) });
    if (split.overtimeHours > 0) earnings.push({ line: 'earning:OVERTIME:0', kind: 'OVERTIME', hours: split.overtimeHours, rate: round2(rate * split.overtimeMultiplier), amount: round2(split.overtimeHours * rate * split.overtimeMultiplier) });
    if (split.doubleTimeHours > 0) earnings.push({ line: 'earning:DOUBLE_TIME:0', kind: 'DOUBLE_TIME', hours: split.doubleTimeHours, rate: round2(rate * split.doubleMultiplier), amount: round2(split.doubleTimeHours * rate * split.doubleMultiplier) });
    const fullGross = round2(earnings.reduce((s, e) => s + e.amount, 0));
    const a = await db.associate.findUnique({
      where: { id: associateId },
      select: {
        employmentType: true,
        state: true,
        w4Submission: { select: { filingStatus: true, extraWithholding: true, deductions: true, otherIncome: true, dependentsAmount: true } },
      },
    });
    const freq = schedule?.frequency ?? 'BIWEEKLY';
    const payFrequency: PayFrequency = freq === 'DAILY' ? 'WEEKLY' : freq;
    const ytd = await computeYtdWages(db, associateId, new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1)), periodStart);
    const t =
      a?.employmentType === 'W2_EMPLOYEE' && fullGross > 0
        ? computePaycheckTaxes({
            grossPay: fullGross,
            filingStatus: a.w4Submission?.filingStatus ?? null,
            payFrequency,
            state: a.state,
            ytdWages: ytd,
            ytdMedicareWages: ytd,
            extraWithholding: a.w4Submission?.extraWithholding ? Number(a.w4Submission.extraWithholding) : 0,
            deductions: a.w4Submission?.deductions ? Number(a.w4Submission.deductions) : 0,
            otherIncome: a.w4Submission?.otherIncome ? Number(a.w4Submission.otherIncome) : 0,
            dependentsAmount: a.w4Submission?.dependentsAmount ? Number(a.w4Submission.dependentsAmount) : 0,
          })
        : null;
    taxes = t
      ? [
          { line: 'tax:FEDERAL', kind: 'FEDERAL' as const, amount: t.federalIncomeTax },
          { line: 'tax:SOCIAL_SECURITY', kind: 'SOCIAL_SECURITY' as const, amount: t.socialSecurity },
          { line: 'tax:MEDICARE', kind: 'MEDICARE' as const, amount: t.medicare },
          { line: 'tax:STATE', kind: 'STATE' as const, amount: t.stateIncomeTax },
        ].filter((x) => x.amount !== 0)
      : [];
    deductions = [];
    gross = fullGross;
    // Daily pay already sent comes off the check.
    net = round2(Math.max(0, fullGross - taxes.reduce((s, x) => s + x.amount, 0) - daily.net));
  }

  return {
    available: true,
    reason: null,
    ...window,
    source,
    days,
    earnings,
    gross: round2(gross),
    taxes,
    deductions,
    paidAhead: daily.net,
    net: round2(net),
    check: check ? { status: check.status as 'CONFIRMED' | 'FLAGGED', flags: (check.flags as unknown as PreviewFlag[]) ?? [], at: check.updatedAt.toISOString() } : null,
  };
}

export async function confirmPayPreview(db: PrismaClient, associateId: string, actorUserId: string, now: Date = new Date()): Promise<PayPreview> {
  const p = await buildPayPreview(db, associateId, now);
  if (!p.available || !p.payDate) throw new HttpError(409, 'preview_not_open', 'Your pay preview isn’t open yet.');
  await db.payPreviewCheck.upsert({
    where: { associateId_payDate: { associateId, payDate: asDate(p.payDate) } },
    create: { associateId, payDate: asDate(p.payDate), periodStart: asDate(p.periodStart!), periodEnd: asDate(p.periodEnd!), status: 'CONFIRMED', estimateNet: p.net, resolvedAt: now },
    // Confirming after a flag keeps the flag (it is still being looked at).
    update: { estimateNet: p.net, ...(p.check?.status === 'FLAGGED' ? {} : { status: 'CONFIRMED', resolvedAt: now }) },
  });
  enqueueAudit({ actorUserId, action: 'payroll.pay_preview.confirmed', entityType: 'Associate', entityId: associateId, metadata: { payDate: p.payDate, net: p.net } }, 'payPreview.confirm');
  return buildPayPreview(db, associateId, now);
}

export interface FlagInput {
  line: string;
  kind: FlagKind;
  note: string;
  /** For a day's hours: the shift and the right times, sent to the lead as a punch correction. */
  timeEntryId?: string | null;
  proposedClockIn?: string | null;
  proposedClockOut?: string | null;
  /** Language the note is in (for the reader). */
  language?: string | null;
}

/** A plain description of a line for the case subject. */
function lineLabel(line: string): string {
  if (line.startsWith('day:')) return `hours on ${line.slice(4)}`;
  if (line.startsWith('earning:')) return `pay line ${line.split(':')[1]?.toLowerCase().replace(/_/g, ' ')}`;
  if (line.startsWith('tax:')) return `${line.slice(4).toLowerCase().replace(/_/g, ' ')} tax`;
  if (line.startsWith('deduction:')) return 'a deduction';
  if (line === 'net') return 'take-home';
  return 'a line';
}

export async function flagPayPreview(
  db: PrismaClient,
  ctx: { associateId: string; userId: string; ip?: string | null; ua?: string | null },
  input: FlagInput,
  now: Date = new Date(),
): Promise<{ preview: PayPreview; routedTo: 'LEAD' | 'PAYROLL'; caseId: string | null; correctionId: string | null }> {
  const p = await buildPayPreview(db, ctx.associateId, now);
  if (!p.available || !p.payDate) throw new HttpError(409, 'preview_not_open', 'Your pay preview isn’t open yet.');
  const note = input.note.trim();
  if (note.length < 3) throw new HttpError(400, 'note_required', 'Say what looks wrong.');

  let correctionId: string | null = null;
  let caseId: string | null = null;
  // A day with the right times goes to the lead as a punch correction —
  // unless payroll already locked that period.
  if (input.kind === 'HOURS' && input.timeEntryId && (input.proposedClockIn || input.proposedClockOut)) {
    try {
      const row = await submitCorrection(
        db,
        { tenantId: tenantIdForWrite(), associateId: ctx.associateId, userId: ctx.userId, ip: ctx.ip ?? null, ua: ctx.ua ?? null },
        { kind: 'WRONG_TIME', timeEntryId: input.timeEntryId, proposedClockIn: input.proposedClockIn ?? null, proposedClockOut: input.proposedClockOut ?? null, reason: `Pay check before payday: ${note}`, attested: true },
      );
      correctionId = row.id;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
    }
  }
  if (!correctionId) {
    const category = 'PAYROLL' as const;
    const priority = 'HIGH' as const;
    const c = await db.hrCase.create({
      data: {
        associateId: ctx.associateId,
        category,
        priority,
        subject: `Pay before payday: ${lineLabel(input.line)} (${p.payDate})`,
        description: [
          note,
          '',
          `Pay date ${p.payDate}, period ${p.periodStart}–${p.periodEnd}. Preview take-home $${p.net.toFixed(2)} (${p.source === 'RUN' ? 'from the run' : 'estimate'}).`,
          input.timeEntryId ? `Shift: ${input.timeEntryId}` : null,
          input.proposedClockIn || input.proposedClockOut ? `Times they gave: ${input.proposedClockIn ?? '—'} to ${input.proposedClockOut ?? '—'}` : null,
          input.language && input.language !== 'en' ? `Written in: ${input.language}` : null,
        ]
          .filter((x) => x !== null)
          .join('\n'),
        dueAt: dueAtFor(now, await targetHoursFor(category, priority)),
      },
    });
    caseId = c.id;
    void notifyAllAdmins({
      subject: 'A worker flagged their pay before payday',
      body: `${lineLabel(input.line)} on the ${p.payDate} check: “${note.slice(0, 140)}”.`,
      category: 'hr-cases',
      linkUrl: `/hr-cases?case=${c.id}`,
      excludeUserId: ctx.userId,
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
    // Their lead hears too — they usually know what happened on the floor.
    void notifyManager(ctx.associateId, {
      subject: 'Someone on your team flagged their pay',
      body: `${lineLabel(input.line)} on the ${p.payDate} check. Payroll has the case.`,
      category: 'hr-cases',
      linkUrl: `/hr-cases?case=${c.id}`,
    });
  }

  const flag: PreviewFlag = { line: input.line, kind: input.kind, note, at: now.toISOString(), caseId, correctionId };
  const existing = await db.payPreviewCheck.findUnique({ where: { associateId_payDate: { associateId: ctx.associateId, payDate: asDate(p.payDate) } } });
  const flags = [...((existing?.flags as unknown as PreviewFlag[]) ?? []), flag];
  await db.payPreviewCheck.upsert({
    where: { associateId_payDate: { associateId: ctx.associateId, payDate: asDate(p.payDate) } },
    create: { associateId: ctx.associateId, payDate: asDate(p.payDate), periodStart: asDate(p.periodStart!), periodEnd: asDate(p.periodEnd!), status: 'FLAGGED', estimateNet: p.net, flags: flags as unknown as Prisma.InputJsonValue },
    update: { status: 'FLAGGED', resolvedAt: null, flags: flags as unknown as Prisma.InputJsonValue },
  });
  enqueueAudit(
    { actorUserId: ctx.userId, action: 'payroll.pay_preview.flagged', entityType: 'Associate', entityId: ctx.associateId, metadata: { payDate: p.payDate, line: input.line, kind: input.kind, caseId, correctionId } },
    'payPreview.flag',
  );
  return { preview: await buildPayPreview(db, ctx.associateId, now), routedTo: correctionId ? 'LEAD' : 'PAYROLL', caseId, correctionId };
}

/**
 * Payroll's view for one period: how many of the people on the check
 * confirmed, flagged, or haven't answered; open flags are a blocker on
 * the guided close. A flag is open until payroll marks it resolved (or the
 * case / correction behind it closes).
 */
export async function payPreviewStats(
  db: Db,
  input: { associateIds: string[]; periodStart: Date; periodEnd: Date },
): Promise<{ people: number; confirmed: number; flagged: number; openFlags: number; unanswered: number; confirmationRate: number; open: Array<{ associateId: string; flags: PreviewFlag[] }> }> {
  const people = input.associateIds.length;
  if (people === 0) return { people: 0, confirmed: 0, flagged: 0, openFlags: 0, unanswered: 0, confirmationRate: 0, open: [] };
  const rows = await db.payPreviewCheck.findMany({
    where: { associateId: { in: input.associateIds }, periodStart: input.periodStart, periodEnd: input.periodEnd },
    select: { associateId: true, status: true, flags: true, resolvedAt: true },
  });
  // A flag whose case resolved or correction was decided counts as handled.
  const flagged = rows.filter((r) => r.status === 'FLAGGED');
  const caseIds = flagged.flatMap((r) => ((r.flags as unknown as PreviewFlag[]) ?? []).map((f) => f.caseId).filter((x): x is string => !!x));
  const corrIds = flagged.flatMap((r) => ((r.flags as unknown as PreviewFlag[]) ?? []).map((f) => f.correctionId).filter((x): x is string => !!x));
  const [closedCases, decided] = await Promise.all([
    caseIds.length ? db.hrCase.findMany({ where: { id: { in: caseIds }, status: { in: ['RESOLVED', 'CLOSED'] } }, select: { id: true } }) : Promise.resolve([]),
    corrIds.length ? db.timeCorrectionRequest.findMany({ where: { id: { in: corrIds }, status: { in: ['APPROVED', 'DENIED', 'WITHDRAWN'] } }, select: { id: true } }) : Promise.resolve([]),
  ]);
  const done = new Set([...closedCases.map((c) => c.id), ...decided.map((d) => d.id)]);
  const open = flagged
    .filter((r) => !r.resolvedAt)
    .map((r) => ({ associateId: r.associateId, flags: ((r.flags as unknown as PreviewFlag[]) ?? []).filter((f) => !(f.caseId && done.has(f.caseId)) && !(f.correctionId && done.has(f.correctionId))) }))
    .filter((r) => r.flags.length > 0);
  const confirmed = rows.filter((r) => r.status === 'CONFIRMED').length;
  return {
    people,
    confirmed,
    flagged: flagged.length,
    openFlags: open.reduce((s, r) => s + r.flags.length, 0),
    unanswered: Math.max(0, people - rows.length),
    confirmationRate: round2(confirmed / people),
    open,
  };
}

/** Payroll marks a worker's flags handled for a pay date. */
export async function resolvePayPreviewFlags(db: PrismaClient, input: { associateId: string; periodStart: Date; periodEnd: Date; actorUserId: string }): Promise<void> {
  await db.payPreviewCheck.updateMany({ where: { associateId: input.associateId, periodStart: input.periodStart, periodEnd: input.periodEnd, status: 'FLAGGED' }, data: { resolvedAt: new Date() } });
  enqueueAudit({ actorUserId: input.actorUserId, action: 'payroll.pay_preview.resolved', entityType: 'Associate', entityId: input.associateId, metadata: { periodStart: ymd(input.periodStart) } }, 'payPreview.resolve');
}
