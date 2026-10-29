import type { Prisma, PrismaClient } from '@prisma/client';
import type { ExecRisk, ExecRiskSeverity, ExecRisks } from '@alto-people/shared';
import { EMPLOYED_WHERE, placements } from './activeDefinition.js';
import { ageStatements } from './books/aging.js';
import { statementBalances } from './books/posting/receivables.js';
import { cashForecast } from './cashForecast.js';
import { addBusinessDays } from './everifyReadiness.js';
import { execMoney, plural } from './execFinance.js';
import { isInternalClientName } from './execClients.js';
import { lastCompleteWeeks } from './execPeriods.js';
import { fmtDay } from './humanDates.js';
import { loadPaidHours } from './paidHours.js';
import { onNoScheduleWhere, PAY_RUN_POPULATION_WHERE } from './payScheduleMembership.js';
import { scopeWhere } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { companyWorkweek, startOfWeekUTC } from './timeAnomalies.js';
import { dateColumnKey, localDateKey } from './timezone.js';

/**
 * The chairman's risk register (GET /executive/risks, the board pack's risk
 * page and the overview's headline risk): what could hurt the company, each
 * with its number, what it means, what retires it, and who owns it. A risk
 * appears only while it is present; the list is highest severity first.
 *
 *   client       revenue concentration — the top client's share of est.
 *                billing over the last 4 complete weeks (≥ 50% medium,
 *                ≥ 70% high), trend against the 4 weeks before
 *   operations   a store with people placed and no active shift or floor
 *                supervisor covering it · a no-call no-show rate over 2% of
 *                assigned shifts in 4 weeks · open safety incidents
 *   compliance   I-9 Section 2 past its three-business-day deadline (or
 *                waiting) · credentials and documents lapsed or lapsing in
 *                30 days (the Expirations page's people) · legal deadlines
 *                passed: leave notices and certifications, unemployment
 *                claim responses, workers' comp first reports · red areas
 *                on the compliance scorecard (the latest daily snapshot,
 *                against four weeks ago)
 *   cash         receivables more than 60 days past due (any over 90 is
 *                high; aged by lib/books/aging) · the 13-week cash forecast
 *                dipping below the company's minimum · people on no pay
 *                schedule, whom no payroll run will pay
 *   client       no client survey in 120 days (low)
 *
 * Every read runs at once; the register answers in well under half a
 * second on the demo company.
 *
 * Where a risk opens (deep audit 2026-10-29, LEAD-6): `href` is always a
 * page every view:executive role can read — an executive page, a page all
 * of them hold the view for, or the Risk page's own read-only detail
 * (`detailHref`, with the records behind the risk in `items`). The desk
 * that works it (the leave desk, the claims desks, the supervisor roster,
 * the cash forecast) rides in `desk` with the capability it needs; the web
 * shows it only to someone who holds it. The chairman is never sent to a
 * page that says "You don't have access", nor to her own "My leave".
 */

export type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const SEVERITY_RANK: Record<ExecRiskSeverity, number> = { high: 0, medium: 1, low: 2 };
/** The owners a risk can name. */
type Owner = 'Clients' | 'HR' | 'Finance' | 'Operations' | 'Compliance';

const SCORECARD_AREAS: Record<string, string> = {
  onboarding: 'onboarding',
  expirations: 'expirations',
  shifts: 'shift coverage',
  billing: 'billing',
  training: 'training',
  safety: 'safety',
};

/** The Risk page's own read-only detail for a risk. */
export const detailHref = (id: string): string => `/executive/risk?open=${encodeURIComponent(id)}`;
/** How many records a risk lists in place. */
const ITEMS_MAX = 10;

const listWords = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pct1 = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

function trendOf(now: number, then: number, tolerance: number): ExecRisk['trend'] {
  if (now > then + tolerance) return 'rising';
  if (now < then - tolerance) return 'easing';
  return 'steady';
}

/** "new" when everything behind a risk appeared in the last four weeks, else "steady". */
const newOrSteady = (oldest: Date | null | undefined, now: Date): ExecRisk['trend'] => (oldest && now.getTime() - oldest.getTime() < 28 * DAY_MS ? 'new' : 'steady');

export async function computeExecRisks(db: Db, now: Date): Promise<ExecRisks> {
  const tenantId = tenantIdForWrite();
  const tz = companyWorkweek().timezone;
  const today = localDateKey(now, tz);
  const todayStart = new Date(`${today}T00:00:00Z`);
  const weeks = lastCompleteWeeks(now, 8);
  const thisWeek = startOfWeekUTC(now);
  const fourAgo = weeks[4]!;
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  const ago28 = new Date(now.getTime() - 28 * DAY_MS);
  const ago56 = new Date(now.getTime() - 56 * DAY_MS);

  const [
    clients,
    shares,
    placed,
    supervisors,
    i9Pending,
    qualifications,
    documents,
    leaveCases,
    uiClaims,
    wcClaims,
    balances,
    forecast,
    scheduleCount,
    unscheduled,
    unscheduledPeople,
    ncns,
    shifts56,
    incidents,
    snapshots,
    lastWave,
    activeClients,
  ] = await Promise.all([
    db.client.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true } }),
    loadPaidHours(db, { tenantId, from: weeks[0]!, to: thisWeek }),
    placements({ tenantId }, db),
    db.user.findMany({
      where: { tenantId, deletedAt: null, status: 'ACTIVE', role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] } },
      select: { id: true, clientId: true, locationId: true, supervisorShiftWindows: { select: { locationId: true } } },
    }),
    db.i9Verification.findMany({
      where: { tenantId, documentsSubmittedAt: { not: null }, section2CompletedAt: null, associate: { deletedAt: null } },
      select: { documentsSubmittedAt: true, associate: { select: { hireDate: true } } },
      take: 5000,
    }),
    // The Expirations page's people (lib/expirationScope), lapsed or lapsing within 30 days.
    db.associateQualification.findMany({
      where: {
        AND: [
          { tenantId, deletedAt: null, expiresAt: { not: null, lte: in30 } },
          { qualification: { deletedAt: null } },
          { associate: { tenantId, deletedAt: null, deactivatedAt: null } },
        ],
      },
      select: { expiresAt: true },
      take: 5000,
    }),
    db.documentRecord.findMany({
      where: {
        tenantId,
        deletedAt: null,
        OR: [{ status: 'EXPIRED' }, { status: { in: ['UPLOADED', 'VERIFIED'] }, expiresAt: { lte: in30 } }],
        associate: { tenantId, ...EMPLOYED_WHERE },
      },
      select: { status: true, expiresAt: true },
      take: 5000,
    }),
    db.leaveCase.findMany({
      where: {
        tenantId,
        OR: [
          { status: 'REQUESTED', noticeSentAt: null },
          { status: 'PENDING_CERTIFICATION', certificationReceivedAt: null, certificationDueAt: { lt: todayStart } },
        ],
      },
      select: { status: true, createdAt: true, certificationDueAt: true },
      take: 1000,
    }),
    db.unemploymentClaim.findMany({ where: { tenantId, status: 'NEW', responseDueAt: { lt: todayStart } }, select: { responseDueAt: true }, take: 1000 }),
    db.wcClaim.findMany({
      where: { tenantId, froiSubmittedAt: null, status: { notIn: ['CLOSED', 'DENIED'] }, froiDueAt: { lt: todayStart } },
      select: { froiDueAt: true },
      take: 1000,
    }),
    statementBalances(db, { paidAt: null }),
    cashForecast(now, { tenantId, weeks: 13 }).catch(() => null),
    db.payrollSchedule.count({ where: { tenantId, isActive: true, deletedAt: null } }),
    db.associate.count({ where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId }, PAY_RUN_POPULATION_WHERE, onNoScheduleWhere(today)) }),
    // The first few of them by name, for the risk's in-place detail.
    db.associate.findMany({
      where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId }, PAY_RUN_POPULATION_WHERE, onNoScheduleWhere(today)),
      select: { firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: ITEMS_MAX,
    }),
    db.attendanceEvent.findMany({
      where: { tenantId, kind: 'NO_CALL_NO_SHOW', excusedAt: null, occurredOn: { gte: new Date(localDateKey(ago56, tz) + 'T00:00:00Z'), lt: todayStart } },
      select: { occurredOn: true },
      take: 20_000,
    }),
    db.shift.findMany({
      where: { tenantId, assignedAssociateId: { not: null }, status: { notIn: ['CANCELLED', 'DRAFT'] }, startsAt: { gte: ago56, lt: now } },
      select: { startsAt: true },
      take: 200_000,
    }),
    db.oshaIncident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, select: { severity: true, status: true, reportedAt: true }, take: 1000 }),
    db.complianceScoreSnapshot.findMany({
      where: { tenantId, clientId: null, day: { gte: new Date(now.getTime() - 35 * DAY_MS) } },
      orderBy: { day: 'desc' },
      select: { day: true, score: true, criticalCount: true, tileSeverities: true },
      take: 40,
    }),
    db.clientNpsWave.findFirst({ where: { tenantId }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    db.client.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE' } }),
  ]);

  const risks: ExecRisk[] = [];
  const push = (r: Omit<ExecRisk, 'owner'> & { owner: Owner }) => risks.push(r);

  // ----- Revenue concentration (last 4 complete weeks against the 4 before)
  const internal = new Set(clients.filter((c) => isInternalClientName(c.name)).map((c) => c.id));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const billedIn = (from: Date, to: Date) => {
    const by = new Map<string, number>();
    for (const s of shares) {
      const cid = s.entry.clientId;
      if (!cid || internal.has(cid) || s.entry.clockInAt < from || s.entry.clockInAt >= to) continue;
      by.set(cid, (by.get(cid) ?? 0) + s.billed);
    }
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && total > 0 ? { clientId: top[0], share: (top[1] / total) * 100, clients: by.size } : null;
  };
  const conc = billedIn(fourAgo, thisWeek);
  const concBefore = billedIn(weeks[0]!, fourAgo);
  if (conc && conc.share >= 50) {
    const name = nameOf.get(conc.clientId) ?? 'One client';
    const share = Math.round(conc.share);
    push({
      id: 'client-concentration',
      category: 'client',
      severity: conc.share >= 70 ? 'high' : 'medium',
      title: `${name} is ${share}% of revenue`,
      detail:
        conc.clients <= 1
          ? 'Every billed hour in the last four weeks came from one client, so losing or repricing that account moves the whole company. Winning a second client of real size retires it.'
          : `Losing or repricing this one account would move the whole company. It retires as other clients grow — below 50%, with no client above it, is the line.`,
      owner: 'Clients',
      trend: concBefore && concBefore.clientId === conc.clientId ? trendOf(conc.share, concBefore.share, 2) : 'new',
      metric: `${pct1(conc.share)} of est. billing, last 4 weeks`,
      href: '/executive/clients',
    });
  }

  // ----- Stores with people placed and no supervisor
  const placedBySite = new Map<string, number>();
  for (const p of placed.values()) if (p.locationId) placedBySite.set(p.locationId, (placedBySite.get(p.locationId) ?? 0) + 1);
  if (placedBySite.size > 0) {
    const siteRows = await db.site.findMany({ where: { tenantId, id: { in: [...placedBySite.keys()] }, deletedAt: null }, select: { id: true, name: true, clientId: true } });
    const covered = (site: { id: string; clientId: string | null }) =>
      supervisors.some((u) => {
        if (u.supervisorShiftWindows.some((x) => x.locationId === site.id)) return true;
        if (u.locationId) return u.locationId === site.id;
        // Bound to the client with no store pinned and no store windows: the whole client.
        return !!site.clientId && u.clientId === site.clientId && u.supervisorShiftWindows.length === 0;
      });
    // The internal-hires pseudo-client's office is staff, not a store.
    const bare = siteRows.filter((s) => !(s.clientId && internal.has(s.clientId)) && !covered(s)).map((s) => ({ ...s, people: placedBySite.get(s.id) ?? 0 })).sort((a, b) => b.people - a.people);
    if (bare.length > 0) {
      const people = bare.reduce((n, s) => n + s.people, 0);
      push({
        id: 'site-supervisor',
        category: 'operations',
        severity: bare.length >= 3 || people >= 20 ? 'high' : 'medium',
        title: bare.length === 1 ? `${bare[0]!.name} has ${plural(people, 'person', 'people')} placed and no supervisor` : `${plural(bare.length, 'store')} have people placed and no supervisor`,
        detail: 'Nobody on site approves their time, takes a call-out or files an incident there. Assigning a shift or floor supervisor to each store retires it.',
        owner: 'Operations',
        trend: 'steady',
        metric: bare.length === 1 ? `${plural(people, 'person', 'people')} placed` : `${plural(people, 'person', 'people')} placed across ${listWords(bare.slice(0, 3).map((s) => s.name))}${bare.length > 3 ? ` and ${bare.length - 3} more` : ''}`,
        // The supervisor roster is manage:org — the stores are listed here instead.
        href: detailHref('site-supervisor'),
        desk: { href: '/scheduling/supervisors', label: 'Open the supervisor roster', requires: 'manage:org' },
        items: bare.slice(0, ITEMS_MAX).map((st) => ({ label: st.name, sub: `${plural(st.people, 'person', 'people')} placed, no shift or floor supervisor` })),
      });
    }
  }

  // ----- I-9 Section 2: three business days from the first day
  if (i9Pending.length > 0) {
    const dueOf = (r: (typeof i9Pending)[number]) => addBusinessDays(r.associate.hireDate ?? r.documentsSubmittedAt!, 3);
    const overdue = i9Pending.filter((r) => dueOf(r).getTime() < todayStart.getTime());
    const oldest = i9Pending.reduce<Date | null>((o, r) => (!o || r.documentsSubmittedAt! < o ? r.documentsSubmittedAt! : o), null);
    push(
      overdue.length > 0
        ? {
            id: 'i9-section2',
            category: 'compliance',
            severity: 'high',
            title: `${plural(overdue.length, 'I-9')} past the Section 2 deadline`,
            detail: 'Section 2 is due within three business days of a new hire’s first day, and each late form is a fine in an audit. HR examining the documents and completing Section 2 for each retires it.',
            owner: 'Compliance',
            trend: newOrSteady(oldest, now),
            metric: `${overdue.length} overdue · ${i9Pending.length} waiting in all`,
            href: '/compliance?tab=i9',
          }
        : {
            id: 'i9-section2',
            category: 'compliance',
            severity: 'low',
            title: `${plural(i9Pending.length, 'I-9')} waiting on Section 2`,
            detail: 'None is late yet; each is due within three business days of the person’s first day. Completing Section 2 retires it.',
            owner: 'Compliance',
            trend: newOrSteady(oldest, now),
            metric: `${i9Pending.length} waiting, none overdue`,
            href: '/compliance?tab=i9',
          },
    );
  }

  // ----- Credentials and documents lapsed or lapsing within 30 days
  const lapsedQ = qualifications.filter((q) => q.expiresAt!.getTime() < todayStart.getTime()).length;
  const lapsedD = documents.filter((d) => d.status === 'EXPIRED' || (d.expiresAt && d.expiresAt.getTime() < now.getTime())).length;
  const expiring = qualifications.length + documents.length;
  if (expiring > 0) {
    const lapsed = lapsedQ + lapsedD;
    push({
      id: 'credential-expirations',
      category: 'compliance',
      severity: lapsed > 0 ? 'medium' : 'low',
      title: lapsed > 0 ? `${plural(lapsed, 'credential')} lapsed, ${expiring - lapsed} more within 30 days` : `${plural(expiring, 'credential')} expire within 30 days`,
      detail: 'Certifications, licenses and identity documents that lapse take the people who hold them off the work that needs them. Renewals on file retire it.',
      owner: 'HR',
      trend: 'steady',
      metric: `${plural(qualifications.length, 'certification or license', 'certifications and licenses')} · ${plural(documents.length, 'document')}`,
      href: '/expirations',
    });
  }

  // ----- Legal deadlines that passed
  const leaveDue = (c: (typeof leaveCases)[number]) => (c.status === 'REQUESTED' ? addBusinessDays(c.createdAt, 5) : c.certificationDueAt!);
  // A notice's due date is an instant (five business days from the request);
  // a certification's is a calendar date (a DATE column, read as stored).
  const leaveDueKey = (c: (typeof leaveCases)[number]) => (c.status === 'REQUESTED' ? localDateKey(leaveDue(c), tz) : dateColumnKey(leaveDue(c)));
  const lateLeave = leaveCases.filter((c) => leaveDue(c).getTime() < todayStart.getTime());
  if (lateLeave.length > 0) {
    const notices = lateLeave.filter((c) => c.status === 'REQUESTED').length;
    const certs = lateLeave.length - notices;
    const oldestCase = [...lateLeave].sort((a, b) => leaveDue(a).getTime() - leaveDue(b).getTime())[0]!;
    const oldestDue = leaveDue(oldestCase);
    push({
      id: 'leave-deadlines',
      category: 'compliance',
      severity: 'high',
      title: notices > 0 && certs === 0 ? `${plural(notices, 'leave notice')} past the legal deadline` : `${plural(lateLeave.length, 'leave case')} past a legal deadline`,
      detail: 'The eligibility and rights notice is owed within five business days of a leave request, and a leave cannot be designated without its certification. Sending each notice and closing out each certification retires it.',
      owner: 'HR',
      trend: newOrSteady(oldestDue, now),
      metric: [notices ? plural(notices, 'notice') : null, certs ? plural(certs, 'certification') : null, `the oldest due ${fmtDay(leaveDueKey(oldestCase))}`].filter(Boolean).join(' · '),
      // /leave is the leave desk only for manage:leave; for anyone else it is
      // their own "My leave". The obligations are listed in place — what is
      // owed and since when, never who or why (leave carries medical facts).
      href: detailHref('leave-deadlines'),
      desk: { href: notices > 0 ? '/leave?status=notices' : '/leave?status=certs-due', label: 'Open the leave desk', requires: 'manage:leave' },
      items: lateLeave
        .map((c) => ({ c, due: leaveDue(c) }))
        .sort((a, b) => a.due.getTime() - b.due.getTime())
        .slice(0, ITEMS_MAX)
        .map(({ c, due }) => {
          const late = Math.max(1, Math.round((todayStart.getTime() - due.getTime()) / DAY_MS));
          const dueKey = leaveDueKey(c);
          return { label: c.status === 'REQUESTED' ? 'Eligibility and rights notice' : 'Medical certification', sub: `Due ${fmtDay(dueKey)} · ${plural(late, 'day')} late` };
        }),
    });
  }
  if (uiClaims.length > 0) {
    const oldest = uiClaims.map((c) => c.responseDueAt).sort((a, b) => a.getTime() - b.getTime())[0]!;
    push({
      id: 'ui-claim-deadlines',
      category: 'compliance',
      severity: 'high',
      title: `${plural(uiClaims.length, 'unemployment claim')} past the response date`,
      detail: 'A late response loses the right to contest and can charge the claim to the company’s account. Answering each with the state retires it.',
      owner: 'HR',
      trend: newOrSteady(oldest, now),
      metric: `The oldest was due ${fmtDay(dateColumnKey(oldest))}`,
      href: detailHref('ui-claim-deadlines'),
      desk: { href: '/claims/unemployment', label: 'Open unemployment claims', requires: 'manage:claims' },
      items: uiClaims
        .map((c) => c.responseDueAt)
        .sort((a, b) => a.getTime() - b.getTime())
        .slice(0, ITEMS_MAX)
        .map((due) => ({ label: 'Response to the state', sub: `Was due ${fmtDay(dateColumnKey(due))} · ${plural(Math.max(1, Math.round((todayStart.getTime() - due.getTime()) / DAY_MS)), 'day')} late` })),
    });
  }
  if (wcClaims.length > 0) {
    const oldest = wcClaims.map((c) => c.froiDueAt).sort((a, b) => a.getTime() - b.getTime())[0]!;
    push({
      id: 'wc-report-deadlines',
      category: 'compliance',
      severity: 'high',
      title: `${plural(wcClaims.length, 'workers’ comp first report')} overdue`,
      detail: 'The first report of injury goes to the carrier by a state deadline; late reports draw penalties and slow the injured person’s care. Sending each report retires it.',
      owner: 'Compliance',
      trend: newOrSteady(oldest, now),
      metric: `The oldest was due ${fmtDay(dateColumnKey(oldest))}`,
      href: detailHref('wc-report-deadlines'),
      desk: { href: '/claims/workers-comp', label: 'Open workers’ comp claims', requires: 'manage:claims' },
      items: wcClaims
        .map((c) => c.froiDueAt)
        .sort((a, b) => a.getTime() - b.getTime())
        .slice(0, ITEMS_MAX)
        .map((due) => ({ label: 'First report of injury to the carrier', sub: `Was due ${fmtDay(dateColumnKey(due))} · ${plural(Math.max(1, Math.round((todayStart.getTime() - due.getTime()) / DAY_MS)), 'day')} late` })),
    });
  }

  // ----- Receivables more than 60 days past due
  const open = balances.filter((b) => b.open > 0).map((b) => ({ ...b, amount: b.open / 100 }));
  const aged = ageStatements(open, now);
  const late = aged.statements.filter((s) => s.daysPastDue > 60);
  if (late.length > 0) {
    const amount = late.reduce((n, s) => n + s.row.amount, 0);
    const over90 = late.filter((s) => s.daysPastDue > 90);
    const oldestDays = Math.max(...late.map((s) => s.daysPastDue));
    const lateThen = late.filter((s) => s.daysPastDue - 28 > 60).length;
    push({
      id: 'receivables-past-60',
      category: 'cash',
      severity: over90.length > 0 ? 'high' : 'medium',
      title: `${execMoney(amount)} of receivables more than 60 days past due`,
      detail: 'Payroll goes out every week while this cash sits with clients; past 90 days it is at real risk of never coming in. Collecting it, or agreeing a payment plan, retires it.',
      owner: 'Finance',
      // Against four weeks ago: what was already past 60 days then (and is still open).
      trend: lateThen === 0 ? 'new' : late.length > lateThen ? 'rising' : 'steady',
      metric: `${plural(late.length, 'statement')} · the oldest ${oldestDays} days past due${over90.length ? ` · ${execMoney(over90.reduce((n, s) => n + s.row.amount, 0))} over 90` : ''}`,
      // Financials' receivables section ages the same statements for every
      // executive role; the books' receivables (view:books) work them.
      href: '/executive/financials',
      desk: { href: '/books/receivables', label: 'Open receivables in the books', requires: 'view:books' },
    });
  }

  // ----- The 13-week cash low against the minimum
  const low = forecast?.lowest ?? null;
  const minimum = forecast?.minimumCash ?? null;
  if (low && ((minimum !== null && low.balance < minimum) || (minimum === null && low.balance < 0))) {
    push({
      id: 'cash-low-point',
      category: 'cash',
      severity: 'high',
      title: minimum !== null ? `Cash is forecast to fall to ${execMoney(low.balance)}, below the ${execMoney(minimum)} minimum` : `Cash is forecast to go below zero, to ${execMoney(low.balance)}`,
      detail: 'The 13-week forecast — paydays, tax deposits and bills against expected collections — reaches its low in that week. Collecting receivables sooner, moving a bill or drawing on credit before then retires it.',
      owner: 'Finance',
      trend: 'steady',
      metric: `The week of ${fmtDay(low.weekStart)}`,
      href: '/executive/financials',
      desk: { href: '/finance/cash-forecast', label: 'Open the cash forecast', requires: 'process:payroll' },
    });
  }

  // ----- People on no pay schedule (a payroll blocker)
  if (scheduleCount > 0 && unscheduled > 0) {
    push({
      id: 'pay-schedule-unassigned',
      category: 'cash',
      severity: 'high',
      title: `${plural(unscheduled, 'person', 'people')} on no pay schedule`,
      detail: 'No payroll run will pay them until a rule, the company default or a person puts them on one — a missed paycheck is a wage claim. Assigning each to a schedule retires it.',
      owner: 'Finance',
      trend: 'steady',
      metric: `${plural(unscheduled, 'hired person', 'hired people')} without a schedule`,
      href: detailHref('pay-schedule-unassigned'),
      desk: { href: '/payroll/schedules?view=unassigned', label: 'Open pay schedules', requires: 'process:payroll' },
      items: unscheduledPeople.map((a) => ({ label: `${a.firstName} ${a.lastName}`.trim(), sub: 'On no pay schedule' })),
    });
  }

  // ----- No-call no-shows over 2% of assigned shifts in 4 weeks
  const ncnsNow = ncns.filter((e) => e.occurredOn.getTime() >= new Date(localDateKey(ago28, tz) + 'T00:00:00Z').getTime()).length;
  const ncnsBefore = ncns.length - ncnsNow;
  const shiftsNow = shifts56.filter((s) => s.startsAt >= ago28).length;
  const shiftsBefore = shifts56.length - shiftsNow;
  const rateNow = shiftsNow > 0 ? (ncnsNow / shiftsNow) * 100 : 0;
  const rateBefore = shiftsBefore > 0 ? (ncnsBefore / shiftsBefore) * 100 : 0;
  if (shiftsNow > 0 && rateNow > 2) {
    push({
      id: 'no-call-no-show',
      category: 'operations',
      severity: rateNow > 5 ? 'high' : 'medium',
      title: `No-call no-shows are ${pct1(rateNow)} of shifts`,
      detail: 'Each one is a shift a client paid for and did not get, and they cluster before people quit. Back under 2% of assigned shifts over four weeks retires it.',
      owner: 'Operations',
      trend: shiftsBefore > 0 ? trendOf(rateNow, rateBefore, 0.5) : 'new',
      metric: `${plural(ncnsNow, 'no-call no-show')} in ${plural(shiftsNow, 'assigned shift')}, last 4 weeks`,
      href: '/call-outs',
    });
  }

  // ----- Open safety incidents
  if (incidents.length > 0) {
    const serious = incidents.filter((i) => i.severity === 'DAYS_AWAY' || i.severity === 'FATAL' || i.status === 'ESCALATED');
    const stale = incidents.filter((i) => now.getTime() - i.reportedAt.getTime() > 14 * DAY_MS);
    const oldest = incidents.reduce<Date | null>((o, i) => (!o || i.reportedAt < o ? i.reportedAt : o), null);
    push({
      id: 'safety-incidents',
      category: 'operations',
      severity: serious.length > 0 || stale.length > 0 ? 'high' : 'medium',
      title: `${plural(incidents.length, 'safety incident')} open`,
      detail: 'An open incident is an injury not yet investigated and closed — the OSHA log and the workers’ comp file wait on it. Investigating and resolving each retires it.',
      owner: 'Operations',
      trend: newOrSteady(oldest, now),
      metric: [serious.length ? `${serious.length} serious or escalated` : null, stale.length ? `${stale.length} open over 14 days` : null].filter(Boolean).join(' · ') || 'All reported in the last 14 days',
      href: '/compliance/osha',
    });
  }

  // ----- Red areas on the compliance scorecard
  const snap = snapshots[0] ?? null;
  if (snap) {
    const tiles = (snap.tileSeverities ?? {}) as Record<string, string>;
    const red = Object.entries(tiles).filter(([, v]) => v === 'critical').map(([k]) => SCORECARD_AREAS[k] ?? k);
    if (red.length > 0 || snap.criticalCount > 0) {
      const then = snapshots.find((s) => now.getTime() - s.day.getTime() >= 27 * DAY_MS) ?? null;
      push({
        id: 'compliance-scorecard',
        category: 'compliance',
        severity: red.length >= 2 || snap.criticalCount >= 10 ? 'high' : 'medium',
        title: red.length > 0 ? `${plural(red.length, 'compliance area')} red on the scorecard` : `${plural(snap.criticalCount, 'critical compliance action')} open`,
        detail: `${red.length > 0 ? `${listWords(red).replace(/^./, (c) => c.toUpperCase())} ${red.length === 1 ? 'is' : 'are'} red. ` : ''}The scorecard is what an auditor or a client's compliance team would see first. Clearing the critical actions retires it.`,
        owner: 'Compliance',
        trend: then ? trendOf(snap.criticalCount, then.criticalCount, 0) : 'steady',
        metric: `Score ${snap.score} · ${plural(snap.criticalCount, 'critical action')}`,
        href: '/compliance?tab=scorecard',
      });
    }
  }

  // ----- No client survey in 120 days
  if (activeClients > 0 && (!lastWave || now.getTime() - lastWave.sentAt.getTime() > 120 * DAY_MS)) {
    push({
      id: 'client-nps-stale',
      category: 'client',
      severity: 'low',
      title: lastWave ? `No client survey in ${Math.floor((now.getTime() - lastWave.sentAt.getTime()) / DAY_MS)} days` : 'No client survey has gone out',
      detail: 'Without a recent NPS wave a client’s unhappiness shows up first as a lost account. Sending this quarter’s survey retires it.',
      owner: 'Clients',
      trend: 'steady',
      metric: lastWave ? `The last went out ${fmtDay(localDateKey(lastWave.sentAt, tz))}` : null,
      href: '/clients/nps',
    });
  }

  risks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { asOf: now.toISOString(), timezone: tz, risks };
}
