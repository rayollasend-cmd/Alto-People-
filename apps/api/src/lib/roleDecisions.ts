// Role-scoped decision queues — the chairman's "Needs your decision"
// pattern, generalized to every seat in the company. Items are GENERATED
// from live data by CAPABILITY (not hardcoded role lists), clamped to the
// user's client scope where the role is site-bound, and auto-clear when
// the underlying condition resolves — the queue is worked by DOING the
// work, so there is no dismiss/snooze lifecycle here (that stays the
// chairman's prerogative on his own queue).

import type { PrismaClient } from '@prisma/client';
import { type Capability, type Role, can as userCan } from '@alto-people/shared';
import { computeNoShowRisk } from './noShowRisk.js';
import { coverageGapLabel, coverageGapPath, coverageGapsForUser } from './coverageGaps.js';
import { companyWorkweek, startOfWeekUTC } from './timeAnomalies.js';
import { pendingDeskApprovals, pendingDeskShiftFills, runningCapabilityKeys } from './agentCapabilities.js';
import { I9_SECTION2, blockerWords, pendingSection2, section2Link } from './complianceAgent.js';
import { INCIDENT_LOOP, closable, incidentWhere, openDays, openIncidents, severityWords } from './incidentLoop.js';
import { COVERAGE_CREDENTIALS, latestCoverage } from './credentialCoverage.js';
import { tenantIdForWrite } from './tenant.js';
import { addDaysInZone, localDateKey } from './timezone.js';
import { addBusinessDays } from './everifyReadiness.js';
import { overdueContractDuties } from './contractDuties.js';
import { stuckWhere } from './applicationFilters.js';
import type { SessionUser } from '../types/express.js';
import { fmtDay } from './humanDates.js';

const DAY_MS = 24 * 3600_000;
/** Company-local "YYYY-MM-DD" (the company's own zone, the same one its
 *  workweek starts in) — the date a deep link opens the schedule or a queue on. */
const ymd = (d: Date) => localDateKey(d, companyWorkweek().timezone);

const DAY_WORDS = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const DAY_WORDS_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/**
 * A due day in words — "Sat, Oct 24" (with the year when it isn't this
 * one) — never an ISO string in a title (F500 SH-4). Takes a calendar day:
 * a YYYY-MM-DD, a date-only column (read at UTC midnight, so its own day),
 * or an instant converted to the company's day by the caller (`ymd`).
 */
export function dayWords(day: string | Date, now: Date = new Date()): string {
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: a date-only column reads at UTC midnight, so its UTC date is the day
  const key = typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10);
  const at = new Date(`${key}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return key;
  return (key.slice(0, 4) === String(now.getUTCFullYear()) ? DAY_WORDS : DAY_WORDS_YEAR).format(at);
}

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SHORT_DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * A deadline in words with how far it is (F500 2026-10-26: "due Sat, Jan 31"
 * beside a red "268d", and "by Fri, Oct 23" three days after it passed):
 *   "was due Oct 23 · 3 days overdue" · "due today" · "due tomorrow" ·
 *   "due Oct 30 · in 4 days" · "due Jan 31, 2027 · in 97 days".
 * The year only when it isn't this one. Takes a calendar day ('YYYY-MM-DD'
 * or a date-only column); `today` is the company's own day.
 */
export function dueWords(day: string | Date, now: Date = new Date()): string {
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: a date-only column reads at UTC midnight, so its UTC date is the day
  const key = typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10);
  const at = new Date(`${key}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return `due ${key}`;
  const today = ymd(now);
  const diff = Math.round((at.getTime() - new Date(`${today}T12:00:00.000Z`).getTime()) / DAY_MS);
  const words = (key.slice(0, 4) === today.slice(0, 4) ? SHORT_DAY : SHORT_DAY_YEAR).format(at);
  if (diff < 0) return `was due ${words} · ${-diff} day${diff === -1 ? '' : 's'} overdue`;
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  return `due ${words} · in ${diff} days`;
}

/**
 * Contract duties (insurance certificates, the OSHA 300A posting, the
 * monthly report) belong to the compliance desk: a role that may manage
 * compliance AND whose craft leads with it — never the recruiter's, the
 * ops manager's or the workforce manager's home just because their
 * capability set is wide (F500 SH-4). Roles with no affinity profile keep
 * what their capabilities allow.
 */
export function ownsContractDuties(user: { role: Role }): boolean {
  if (!userCan(user as Parameters<typeof userCan>[0], 'manage:compliance')) return false;
  const profile = ROLE_PROFILES[user.role];
  return !profile || profile.lead.includes('compliance');
}

export type DecisionDomain =
  | 'site-ops'
  | 'people'
  | 'hiring'
  | 'compliance'
  | 'money'
  | 'personal';

export interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  /** Which craft this item belongs to — drives the role-affinity layer. */
  domain: DecisionDomain;
  /** One-tap resolution, when a safe bulk fix exists — the button label
   *  shown on the item (POST /me/decisions/quick executes it). */
  quickAction?: string;
  /** The item's "no" beside its quick action (an agent's proposal: Reject). POST /me/decisions/quick with decline. */
  declineAction?: string;
  /**
   * The calendar day ('YYYY-MM-DD', the company's) the item is due, when its
   * label already says "was due … · N days overdue" / "due … · in N days" —
   * the queue then draws no second age chip beside it.
   */
  dueDay?: string;
}

const SEVERITY_RANK = { critical: 0, high: 1, normal: 2 } as const;

/**
 * Role affinity — capabilities gate ACCESS, this shapes RELEVANCE. Six
 * roles share the identical full-admin capability set as product policy,
 * so a pure capability engine served the Marketing Manager the same
 * queue as the HR Administrator. Each role leads with its own craft and
 * excludes domains that aren't its job (personal items are never
 * excluded). Roles not listed keep everything their capabilities allow.
 */
const ROLE_PROFILES: Partial<
  Record<Role, { lead: DecisionDomain[]; exclude: DecisionDomain[] }>
> = {
  SHIFT_SUPERVISOR: { lead: ['site-ops', 'people'], exclude: [] },
  FINANCE_ACCOUNTANT: { lead: ['money'], exclude: [] },
  // Role walk HR 2: the HR desk leads with legal deadlines; chasing a
  // client's statement is Finance's, not hers.
  HR_ADMINISTRATOR: { lead: ['compliance', 'hiring', 'people'], exclude: ['money'] },
  OPERATIONS_MANAGER: { lead: ['site-ops', 'people', 'money'], exclude: [] },
  MANAGER: { lead: ['people', 'site-ops'], exclude: ['money', 'compliance', 'hiring'] },
  // F500 SH-4: the recruiter's craft is hiring; compliance duties are the HR desk's.
  INTERNAL_RECRUITER: { lead: ['hiring'], exclude: ['money', 'site-ops', 'people'] },
  WORKFORCE_MANAGER: { lead: ['site-ops', 'people', 'hiring'], exclude: ['money'] },
  // Marketing runs communications, not operations — their queue is
  // honestly quiet rather than a copy of HR's worries.
  MARKETING_MANAGER: {
    lead: [],
    exclude: ['site-ops', 'people', 'hiring', 'compliance', 'money'],
  },
};

interface QueueUser {
  id: string;
  role: Role;
  clientId: string | null;
  associateId: string | null;
  /** A site-bound account (a direct employer's property manager): its desk is that site. */
  locationId?: string | null;
  /** A site- or region-limited account's reach (lib/scope.internalSites). */
  scopeSiteIds?: string[];
  scopeRegionIds?: string[];
}

export async function computeRoleDecisions(
  prisma: PrismaClient,
  user: QueueUser,
  now: Date = new Date(),
): Promise<RoleDecision[]> {
  const out: RoleDecision[] = [];
  const can = (c: Capability) => userCan(user, c);
  const thisWeekStart = startOfWeekUTC(now);
  // Client-scoped operators see their site; org roles see everything.
  const clientClamp = user.clientId ? { clientId: user.clientId } : {};
  // Scope-aware keys: two supervisors at the SAME site share one item
  // (and see each other's claims); different sites never collide.
  const scoped = (key: string) => (user.clientId ? `${key}:${user.clientId}` : key);

  /* ----- Site operations (supervisors + anyone managing time) ----------- */
  if (can('manage:time')) {
    const queueFloor = new Date(now.getTime() - 90 * DAY_MS);
    const [walkIns, unapproved, oldestUnapproved] = await Promise.all([
      prisma.clockInRequest.findMany({
        where: { status: 'PENDING', ...clientClamp },
        select: { requestedAt: true },
        take: 100,
      }),
      // The same 90-day window the Inbox counts — older COMPLETED rows are
      // history, not a queue (countApprovalQueues).
      prisma.timeEntry.count({
        where: { status: 'COMPLETED', clockInAt: { gte: queueFloor, lt: thisWeekStart }, ...clientClamp },
      }),
      prisma.timeEntry.findFirst({
        where: { status: 'COMPLETED', clockInAt: { gte: queueFloor, lt: thisWeekStart }, ...clientClamp },
        orderBy: { clockInAt: 'asc' },
        select: { clockInAt: true },
      }),
    ]);
    if (walkIns.length > 0) {
      const oldestMin = Math.max(
        ...walkIns.map((w) => Math.round((now.getTime() - w.requestedAt.getTime()) / 60_000)),
      );
      out.push({
        key: scoped('walkins:pending'),
        domain: 'site-ops',
        severity: 'critical',
        label: `${walkIns.length} walk-in clock-in${walkIns.length === 1 ? '' : 's'} waiting on you`,
        detail: `Someone is standing at a kiosk unable to work — oldest has waited ${oldestMin} minutes.`,
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals?tab=walkins',
        quickAction: 'Approve all',
      });
    }
    if (unapproved >= 10) {
      out.push({
        key: scoped('time:unapproved'),
        domain: 'site-ops',
        severity: unapproved >= 100 ? 'high' : 'normal',
        label: `${unapproved} punches from past weeks awaiting approval`,
        detail: 'Unapproved time is unbillable and holds up payroll — run timesheet approval.',
        stakes: null,
        ageDays: null,
        // The queue, opened on exactly the weeks that fired this: the oldest
        // unapproved punch through the day before this week.
        // `to` is the last instant before this week, read as a local day.
        linkUrl: `/time-attendance?tab=queue&from=${ymd(oldestUnapproved?.clockInAt ?? queueFloor)}&to=${ymd(new Date(thisWeekStart.getTime() - 1))}`,
      });
    }
  }
  // Store-ops floor signals — keys mirrored with the executive engine
  // (same convention as time:unapproved: scoped for bounded supervisors,
  // plain for org-wide roles).
  if (can('view:ops') || can('run:ops-shifts')) {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
    const [tempAlerts, incompleteCloses, urgentHandover] = await Promise.all([
      prisma.opsTask.count({
        where: {
          tempOutOfRange: true,
          updatedAt: { gte: dayAgo },
          opsShift: { is: { ...clientClamp } },
        },
      }),
      prisma.opsShift.count({
        where: { closedIncomplete: true, closedAt: { gte: dayAgo }, ...clientClamp },
      }),
      prisma.opsHandoverItem.count({
        where: {
          status: 'PENDING',
          createdAt: { gte: twoDaysAgo },
          OR: [{ kind: 'COACH_COMPLAINT' }, { kind: 'EQUIPMENT' }],
          fromShift: { is: { ...clientClamp } },
        },
      }),
    ]);
    if (urgentHandover > 0) {
      out.push({
        key: scoped('ops:floor-escalations'),
        domain: 'site-ops',
        severity: 'high',
        label: `${urgentHandover} floor escalation${urgentHandover === 1 ? '' : 's'} — coach complaints / equipment`,
        detail: 'Logged on the floor and unresolved — read them and act before the client calls.',
        stakes: null,
        ageDays: null,
        linkUrl: '/ops',
      });
    }
    if (tempAlerts > 0) {
      out.push({
        key: scoped('ops:temp-alerts'),
        domain: 'site-ops',
        severity: 'critical',
        label: `${tempAlerts} temperature reading${tempAlerts === 1 ? '' : 's'} out of range`,
        detail: 'Food-safety equipment may be failing — check the cases and log the fix.',
        stakes: null,
        ageDays: null,
        linkUrl: '/ops',
      });
    }
    if (incompleteCloses > 0) {
      out.push({
        key: scoped('ops:incomplete'),
        domain: 'site-ops',
        severity: 'high',
        label: `${incompleteCloses} ops shift${incompleteCloses === 1 ? '' : 's'} closed with required work unfinished`,
        detail: 'The record says the standard was not met — read the closing notes and follow up.',
        stakes: null,
        ageDays: null,
        linkUrl: '/ops',
      });
    }
  }
  if (can('manage:scheduling')) {
    // isOpenShift (@alto-people/shared): published, OPEN and not over yet —
    // the one rule every "open shifts" count reads, here narrowed to the
    // next 24 hours. A shift that ended unfilled is history, never a decision.
    const openWhere = {
      publishedAt: { not: null },
      status: 'OPEN' as const,
      assignedAssociateId: null,
      startsAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) },
      endsAt: { gt: now },
      ...clientClamp,
    };
    const [openToday, openSpan, claims] = await Promise.all([
      prisma.shift.count({ where: openWhere }),
      prisma.shift.aggregate({ where: openWhere, _min: { startsAt: true }, _max: { startsAt: true } }),
      prisma.openShiftClaim.count({
        where: { status: 'PENDING', ...(user.clientId ? { shift: { clientId: user.clientId } } : {}) },
      }),
    ]);
    if (openToday > 0) {
      out.push({
        key: scoped('shifts:open-24h'),
        domain: 'site-ops',
        severity: 'high',
        label: `${openToday} shift${openToday === 1 ? '' : 's'} in the next 24h still unassigned`,
        detail:
          'The auto-fill engine already invited the eligible bench — these still need a hand.',
        stakes: null,
        ageDays: null,
        // The next 24h can straddle midnight: one day's view when they all
        // fall on one day, else the week, opened on the first of them.
        linkUrl: (() => {
          const first = openSpan._min.startsAt ?? now;
          const last = openSpan._max.startsAt ?? first;
          return `/scheduling?open=1&view=${ymd(first) === ymd(last) ? 'day' : 'week'}&date=${ymd(first)}`;
        })(),
      });
    }
    // Prediction, not reaction: tomorrow's shifts held by high-risk
    // attendees, flagged tonight (site-scoped callers only — org admins
    // get the evening digest instead of a per-site row).
    if (user.clientId) {
      const risky = await computeNoShowRisk(prisma, now, user.clientId);
      if (risky.length > 0) {
        out.push({
          key: scoped('risk:tomorrow'),
          domain: 'site-ops',
          severity: 'high',
          label: `${risky.length} of tomorrow's shifts ${risky.length === 1 ? 'is' : 'are'} held by high-risk attendees`,
          detail: `History-based flag (${risky
            .slice(0, 3)
            .map((r) => r.holderName)
            .join(', ')}) — worth a confirmation text tonight or a pre-arranged backup.`,
          stakes: null,
          ageDays: null,
          linkUrl: `/scheduling?view=day&risk=1&date=${ymd(addDaysInZone(now, 1, companyWorkweek().timezone))}`,
        });
      }
    }
    if (claims > 0) {
      out.push({
        key: scoped('claims:pending'),
        domain: 'site-ops',
        severity: 'normal',
        label: `${claims} open-shift pickup${claims === 1 ? '' : 's'} awaiting review`,
        detail: 'Associates volunteered — a fast yes fills the schedule and rewards initiative.',
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals?tab=pickups',
      });
    }
    // The hole in tonight's crew (lib/coverageGaps): a window this person
    // leads today with fewer scheduled than the store contracted. The
    // same definition feeds the Inbox, so the bell and the badge agree
    // with the home's notice instead of saying "all clear" above 0 of 6.
    for (const g of await coverageGapsForUser(prisma, user.id, now)) {
      out.push({
        key: `coverage:${g.window.locationId}:${g.window.label}`,
        domain: 'site-ops',
        severity: 'high',
        label: coverageGapLabel(g),
        detail:
          g.openShiftIds.length > 0
            ? `${g.openShiftIds.length} open shift${g.openShiftIds.length === 1 ? '' : 's'} in the window — fill from the bench.`
            : 'Nothing is posted for the window yet — add shifts on today’s schedule.',
        stakes: null,
        ageDays: null,
        linkUrl: coverageGapPath(g),
      });
    }
  }

  /* ----- People management (managers + admins) --------------------------- */
  // A MANAGER's queue is team-wide, not org-wide: when their login links
  // to an associate record, approvals count only their direct reports.
  // Other roles (and managers without team linkage) stay org-wide.
  const teamClamp =
    user.role === 'MANAGER' && user.associateId
      ? { associate: { managerId: user.associateId } }
      : {};
  if (can('approve:reimbursement')) {
    const pending = await prisma.reimbursement.count({
      where: { status: 'SUBMITTED', ...teamClamp },
    });
    if (pending > 0) {
      out.push({
        key: 'reimbursements:approve',
        domain: 'people',
        severity: 'normal',
        label: `${pending} reimbursement${pending === 1 ? '' : 's'} awaiting your approval`,
        detail: 'Associates fronted this money — a quick decision keeps trust intact.',
        stakes: null,
        ageDays: null,
        linkUrl: '/reimbursements?status=approve',
      });
    }
  }
  if (can('manage:team-time-off')) {
    const pending = await prisma.timeOffRequest.count({
      where: { status: 'PENDING', ...teamClamp },
    });
    if (pending > 0) {
      out.push({
        key: 'timeoff:pending',
        domain: 'people',
        severity: 'normal',
        label: `${pending} time-off request${pending === 1 ? '' : 's'} awaiting a decision`,
        detail: 'People are holding plans on your answer.',
        stakes: null,
        ageDays: null,
        // The approvals desk has the bulk and keyboard queue for these.
        linkUrl: '/approvals?tab=time-off',
      });
    }
  }

  /* ----- Hiring & compliance (HR admins) --------------------------------- */
  if (can('manage:onboarding')) {
    const [stuck, i9Pending] = await Promise.all([
      prisma.application.count({
        where: {
          deletedAt: null,
          status: { in: ['SUBMITTED', 'IN_REVIEW'] },
          updatedAt: { lt: new Date(now.getTime() - 5 * DAY_MS) },
        },
      }),
      prisma.i9Verification.count({
        where: {
          section1CompletedAt: { not: null },
          section2CompletedAt: null,
          associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
        },
      }),
    ]);
    if (stuck > 0) {
      out.push({
        key: 'onboarding:stuck',
        domain: 'hiring',
        severity: stuck >= 5 ? 'high' : 'normal',
        label: `${stuck} candidate${stuck === 1 ? '' : 's'} stuck in review over 5 days`,
        detail: 'Every stalled day risks losing them to another employer.',
        stakes: null,
        ageDays: null,
        // Carry the filter that made this fire — the URL param beats the
        // list's persisted status chip.
        linkUrl: '/onboarding?status=TO_REVIEW',
      });
    }
    // Agent families step 4: with the Compliance agent's i9.section2 running, the desk
    // gets a dated worklist (one item a hire, earliest deadline first) instead of a count.
    const section2Running = (await runningCapabilityKeys(prisma, tenantIdForWrite())).has(I9_SECTION2);
    const hires = section2Running ? await pendingSection2(prisma, tenantIdForWrite()) : [];
    if (section2Running && hires.length > 0 && hires.length <= 5) {
      // Today is the company's day (CODE-14) — the UTC date reads "due today" a day early in the evening.
      const today = ymd(now);
      for (const h of hires) {
        // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: dueBy is built from a @db.Date (UTC midnight), so its UTC date is the day
        const due = h.dueBy ? h.dueBy.toISOString().slice(0, 10) : null;
        out.push({
          key: `i9:section2:${h.associateId}`,
          domain: 'hiring',
          severity: !due ? 'high' : due < today ? 'critical' : due === today ? 'high' : 'normal',
          label: due ? `I-9 Section 2 for ${h.name} — ${dueWords(due, now)}` : `I-9 Section 2 for ${h.name}: no start date on file`,
          ...(due ? { dueDay: due } : {}),
          detail: h.blockers.length ? `E-Verify cannot open yet: ${h.blockers.map(blockerWords).join(', ')}.` : 'E-Verify can open once Section 2 is done.',
          stakes: null,
          ageDays: null,
          linkUrl: section2Link(h),
        });
      }
    } else if (section2Running && hires.length > 5) {
      const first = hires[0]!;
      out.push({
        key: 'i9:section2',
        domain: 'hiring',
        severity: 'high',
        label: `${hires.length} I-9 Section 2 verifications pending${first.dueBy ? `, the first due ${fmtDay(first.dueBy, { weekday: true, now })}` : ''}`,
        detail: 'Federal deadline: Section 2 within 3 business days of the start date. Earliest first on the I-9 tab.',
        stakes: null,
        ageDays: null,
        linkUrl: '/compliance?tab=i9',
      });
    } else if (!section2Running && i9Pending > 0) {
      out.push({
        key: 'i9:section2',
        domain: 'hiring',
        severity: 'high',
        label: `${i9Pending} I-9 Section 2 verification${i9Pending === 1 ? '' : 's'} pending`,
        detail: 'Federal deadline: Section 2 within 3 business days of the start date.',
        stakes: null,
        ageDays: null,
        // Land on the I-9 tab, not the Scorecard default.
        linkUrl: '/compliance?tab=i9',
      });
    }
  }
  if (can('manage:compliance')) {
    // Agent families step 5: with incident.loop running, every incident open 3 days is a dated item.
    if ((await runningCapabilityKeys(prisma, tenantIdForWrite())).has(INCIDENT_LOOP)) {
      const aged = (await openIncidents(prisma, tenantIdForWrite())).filter((i) => openDays(i, now) >= 3);
      if (aged.length > 0 && aged.length <= 5) {
        for (const i of aged) {
          const days = openDays(i, now);
          out.push({
            key: `safety:incident:${i.id}`,
            domain: 'compliance',
            severity: i.severity === 'FATAL' || i.severity === 'DAYS_AWAY' || days >= 14 ? 'critical' : 'high',
            label: `${severityWords(i.severity)} incident at ${incidentWhere(i)}, open ${days} days`,
            detail: closable(i, now)
              ? 'Nothing recordable here: close it if the reporter has nothing to add.'
              : i.hrCaseId
                ? 'An HR case is open for it. Update the incident as the case moves.'
                : 'Update it or resolve it on the OSHA page.',
            stakes: null,
            ageDays: days,
            linkUrl: '/compliance/osha',
          });
        }
      } else if (aged.length > 5) {
        out.push({
          key: 'safety:incidents-aged',
          domain: 'compliance',
          severity: 'critical',
          label: `${aged.length} safety incidents open 3 days or more`,
          detail: 'The oldest first on the OSHA page.',
          stakes: null,
          ageDays: openDays(aged[0]!, now),
          linkUrl: '/compliance/osha',
        });
      }
    }
    // Agent families step 5: the week's credential gaps against what each site requires.
    if ((await runningCapabilityKeys(prisma, tenantIdForWrite())).has(COVERAGE_CREDENTIALS)) {
      const short = (await latestCoverage(prisma, tenantIdForWrite())).filter((r) => r.latest && r.latest.missing > 0);
      if (short.length > 0 && short.length <= 5) {
        for (const r of short) {
          out.push({
            key: `credentials:gap:${r.id}`,
            domain: 'compliance',
            severity: 'high',
            label: `${r.label} at ${r.place}: ${r.latest!.missing} of ${r.latest!.population} without it`,
            detail: 'The Compliance agent asked each of them this week, in their language.',
            stakes: null,
            ageDays: null,
            linkUrl: '/compliance?tab=requirements',
          });
        }
      } else if (short.length > 5) {
        out.push({
          key: 'credentials:gaps',
          domain: 'compliance',
          severity: 'high',
          label: `${short.length} site requirements not fully covered`,
          detail: 'Each gap, with who is missing it, on the requirements tab.',
          stakes: null,
          ageDays: null,
          linkUrl: '/compliance?tab=requirements',
        });
      }
    }
    // Agent families step 4: what the Compliance agent chased and the person did not renew.
    const expired = await prisma.documentChase.findMany({
      where: { tenantId: tenantIdForWrite(), escalatedAt: { not: null }, resolvedAt: null },
      orderBy: { expiresAt: 'asc' },
      select: { id: true, label: true, expiresAt: true, associateId: true, stage: true, associate: { select: { firstName: true, lastName: true } } },
      take: 200,
    });
    if (expired.length > 0 && expired.length <= 5) {
      for (const c of expired) {
        out.push({
          key: `compliance:expired:${c.id}`,
          domain: 'compliance',
          severity: 'critical',
          label: `${c.associate.firstName} ${c.associate.lastName}: ${c.label} expired ${fmtDay(c.expiresAt, { now })}`,
          detail: `The Compliance agent asked them ${c.stage} time${c.stage === 1 ? '' : 's'}; nothing newer is on file. Collect the renewal, or waive it on the scorecard.`,
          stakes: null,
          ageDays: Math.max(0, Math.floor((now.getTime() - c.expiresAt.getTime()) / DAY_MS)),
          // Their documents, not the profile's first tab.
          linkUrl: `/people/${c.associateId}?tab=documents`,
        });
      }
    } else if (expired.length > 5) {
      out.push({
        key: 'compliance:expired-chased',
        domain: 'compliance',
        severity: 'critical',
        label: `${expired.length} documents expired after the Compliance agent chased them`,
        detail: 'Nothing newer is on file. Collect the renewals, or waive them on the scorecard.',
        stakes: null,
        ageDays: null,
        linkUrl: '/expirations?view=list',
      });
    }
    const expiring = await prisma.documentRecord.findMany({
      where: {
        deletedAt: null,
        kind: { in: ['ID', 'I9_SUPPORTING', 'J1_VISA', 'J1_DS2019'] },
        expiresAt: { gte: now, lt: new Date(now.getTime() + 30 * DAY_MS) },
        associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
      },
      select: { associateId: true },
      take: 500,
    });
    const people = new Set(expiring.map((d) => d.associateId)).size;
    if (people > 0) {
      out.push({
        key: 'compliance:expiring-docs',
        domain: 'compliance',
        severity: 'high',
        label: `${people} associate${people === 1 ? "'s" : "s'"} work documents expire within 30 days`,
        detail: 'Expired documents block legal work — collect renewals now.',
        stakes: null,
        ageDays: null,
        linkUrl: '/expirations?view=list',
      });
    }
  }
  if (can('manage:org')) {
    // Per-associate keys, IDENTICAL to the executive engine's — the
    // chairman and HR collaborate on the same item, not two shadows.
    const paused = await prisma.associate.findMany({
      where: { deletedAt: null, deactivatedAt: { lt: new Date(now.getTime() - 42 * DAY_MS) } },
      select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
      take: 5,
    });
    for (const p of paused) {
      const days = Math.floor((now.getTime() - p.deactivatedAt!.getTime()) / DAY_MS);
      out.push({
        key: `associate:paused:${p.id}`,
        domain: 'people',
        severity: 'normal',
        label: `${p.firstName} ${p.lastName} has been paused ${days} days`,
        detail: 'Limbo is the wrong state — reactivate them or run a separation.',
        stakes: null,
        ageDays: days,
        linkUrl: `/people?associateId=${p.id}`,
        quickAction: 'Reactivate',
      });
    }
  }

  /* ----- Legal clocks on the HR desk (role walk HR 2) ---------------------- */
  // One item a record, so the home lands on the case itself; more than
  // PER_RECORD_CAP of a kind fold into one summary that opens the list.
  await pushLegalDeadlines(prisma, can, out, now);
  if (ownsContractDuties(user)) await pushContractDuties(prisma, user, out, now);

  /* ----- Money (payroll / finance) ---------------------------------------- */
  if (can('settle:reimbursement')) {
    const toSettle = await prisma.reimbursement.count({
      where: { status: 'MANAGER_APPROVED' },
    });
    if (toSettle > 0) {
      out.push({
        key: 'reimbursements:settle',
        domain: 'money',
        severity: 'normal',
        label: `${toSettle} approved reimbursement${toSettle === 1 ? '' : 's'} to settle`,
        detail: 'Fold them into the next regular payroll run.',
        stakes: null,
        ageDays: null,
        linkUrl: '/reimbursements?status=ready',
      });
    }
  }
  if (can('process:payroll')) {
    const statementTotal = (snapshot: unknown): number => {
      const t = (snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
      return typeof t === 'number' ? t : 0;
    };
    const [drafts, unpaid] = await Promise.all([
      prisma.clientStatement.findMany({
        where: { status: 'DRAFT', updatedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
        select: { snapshot: true },
        take: 50,
      }),
      prisma.clientStatement.findMany({
        where: {
          status: 'FINAL',
          paidAt: null,
          finalizedAt: { lt: new Date(now.getTime() - 45 * DAY_MS) },
        },
        select: {
          id: true,
          number: true,
          snapshot: true,
          finalizedAt: true,
          dueAt: true,
          client: { select: { name: true } },
        },
        take: 20,
      }),
    ]);
    if (drafts.length > 0) {
      const total = drafts.reduce((n, d) => n + statementTotal(d.snapshot), 0);
      out.push({
        // Same key as the executive engine — one shared item.
        key: 'statements:stale-drafts',
        domain: 'money',
        severity: 'normal',
        label: `${drafts.length} draft statement${drafts.length === 1 ? '' : 's'} to finalize`,
        detail: 'Drafts idle over a week are unbilled revenue.',
        stakes: total || null,
        ageDays: null,
        linkUrl: '/clients/statements?status=DRAFT',
      });
    }
    // Per-statement, with keys IDENTICAL to the executive engine's, so a
    // Finance claim shows on the chairman's queue and vice versa.
    for (const s of unpaid) {
      // The age Finance's receivables show: days past the due date (the
      // client's terms), not days since it was finalized — one receivable,
      // one age (F500 SH-4). Days since finalized only when no due date is set.
      const sinceFinal = s.finalizedAt ? Math.floor((now.getTime() - s.finalizedAt.getTime()) / DAY_MS) : 0;
      const pastDue = s.dueAt ? Math.max(0, Math.floor((now.getTime() - s.dueAt.getTime()) / DAY_MS)) : null;
      const days = pastDue ?? sinceFinal;
      const amount = statementTotal(s.snapshot);
      const money = amount ? `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ` : '';
      out.push({
        key: `receivable:${s.id}`,
        domain: 'money',
        severity: days >= 60 || amount >= 5_000 ? 'critical' : 'high',
        label: `Chase ${s.client.name} statement #${s.number ?? '—'}`,
        detail:
          pastDue !== null
            ? `${money}${pastDue} day${pastDue === 1 ? '' : 's'} past due (due ${dayWords(s.dueAt!, now)}) — chase the cash or flag it upward.`
            : `${money}${sinceFinal} days since it was sent, no due date set — chase the cash or flag it upward.`,
        stakes: amount || null,
        ageDays: days,
        linkUrl: `/clients/statements?statement=${s.id}`, // the statement itself
      });
    }
  }

  /* ----- Agent requests the desk decides (agent families step 0) -------- */
  // A shift an agent proposes to fill is the scheduling desk's call; an HR
  // case it proposes to open is HR's. Nothing happens until someone here
  // approves (decision 2). Bounded supervisors count only their own shifts.
  if (can('manage:scheduling')) {
    const bounds = { clientId: user.clientId, locationId: user.locationId ?? null };
    const fills = await pendingDeskShiftFills(prisma, tenantIdForWrite(), bounds);
    // The first few are items of their own, each opening the proposal with its evidence on
    // the Approvals page, with Approve and Reject here (agent families step 1). Past that, one
    // item carries the count and opens the whole queue.
    const SHOWN = 5;
    for (const f of fills.slice(0, SHOWN)) {
      out.push({
        key: `agents:shift-fill:${f.approvalId}`,
        domain: 'site-ops',
        severity: 'high',
        label: f.summary,
        detail: 'Proposed by an agent. Nothing is assigned until you approve; it then assigns under the same rules as the schedule. Open it to read why this person.',
        stakes: null,
        ageDays: Math.floor((now.getTime() - f.requestedAt.getTime()) / DAY_MS),
        linkUrl: `/approvals?tab=proposals&proposal=${f.approvalId}`,
        quickAction: 'Approve',
        declineAction: 'Reject',
      });
    }
    if (fills.length > SHOWN) {
      const n = fills.length;
      out.push({
        key: scoped('agents:shift-assign'),
        domain: 'site-ops',
        severity: 'high',
        label: `${n} shift fills proposed by an agent, waiting on you — see all`,
        detail: `${SHOWN} are listed here. Nothing is assigned until you approve; each one names the shift, the person and why.`,
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals?tab=proposals',
      });
    }
  }
  if (can('manage:onboarding')) {
    const n = await pendingDeskApprovals(prisma, tenantIdForWrite(), 'CASE_OPEN');
    if (n > 0) {
      out.push({
        key: 'agents:case-open',
        domain: 'people',
        severity: 'high',
        label: `${n} HR case${n === 1 ? '' : 's'} an agent proposes to open`,
        detail: 'Nothing is opened until you approve. Each one says why.',
        stakes: null,
        ageDays: null,
        linkUrl: '/approvals?tab=proposals',
      });
    }
  }

  /* ----- Personal to-dos (anyone with an associate record) --------------- */
  if (user.associateId) {
    const [openTasks, expiringOwn] = await Promise.all([
      prisma.application.findFirst({
        where: { associateId: user.associateId, deletedAt: null },
        orderBy: { invitedAt: 'desc' },
        select: {
          checklist: {
            select: { tasks: { select: { status: true } } },
          },
        },
      }),
      prisma.documentRecord.count({
        where: {
          associateId: user.associateId,
          deletedAt: null,
          expiresAt: { gte: now, lt: new Date(now.getTime() + 60 * DAY_MS) },
        },
      }),
    ]);
    const remaining =
      openTasks?.checklist?.tasks.filter(
        (t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS',
      ).length ?? 0;
    if (remaining > 0) {
      out.push({
        // Personal keys carry the user id: the room (thread, claim, next
        // step) hangs off the key, and a shared 'me:…' key pooled every
        // user's personal room into one thread everyone could read.
        key: `me:${user.id}:onboarding-tasks`,
        domain: 'personal',
        severity: 'high',
        label: `${remaining} onboarding task${remaining === 1 ? '' : 's'} left to finish`,
        detail: 'Finishing them clears you for the schedule and payroll.',
        stakes: null,
        ageDays: null,
        linkUrl: '/onboarding',
      });
    }
    if (expiringOwn > 0) {
      out.push({
        key: `me:${user.id}:expiring-docs`,
        domain: 'personal',
        severity: 'high',
        label: `${expiringOwn} of your documents expire${expiringOwn === 1 ? 's' : ''} within 60 days`,
        detail: 'Upload the renewal before it blocks you from working.',
        stakes: null,
        ageDays: null,
        linkUrl: '/me',
      });
    }
  }

  // Role affinity: exclude domains that aren't this role's job (never
  // personal items), then rank severity → own-craft-first → stakes.
  const profile = ROLE_PROFILES[user.role];
  // Each decision once: the "Needs you" count is the queue's rows, so a key
  // pushed twice (two engines naming the same item) must count once.
  const seen = new Set<string>();
  const filtered = (profile ? out.filter((d) => d.domain === 'personal' || !profile.exclude.includes(d.domain)) : out).filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
  const leadRank = (d: RoleDecision): number => {
    if (!profile) return 99;
    const i = profile.lead.indexOf(d.domain);
    return i === -1 ? 99 : i;
  };
  filtered.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const lead = leadRank(a) - leadRank(b);
    if (lead !== 0) return lead;
    return (b.stakes ?? 0) - (a.stakes ?? 0);
  });
  return filtered;
}

/**
 * Contract duties past due (role walk HR 2): the MSA / SOW / MTSA duties
 * confirmed on the compliance scorecard, one read for every duty
 * (lib/contractDuties) — the same list the Inbox counts. One item a duty,
 * folded into one past PER_RECORD_CAP; each opens the scorecard.
 */
async function pushContractDuties(prisma: PrismaClient, user: QueueUser, out: RoleDecision[], now: Date): Promise<void> {
  const duties = await overdueContractDuties(prisma, { ...user, clientId: user.clientId ?? null } as unknown as SessionUser, now);
  if (duties.count === 0) return;
  if (duties.count > PER_RECORD_CAP) {
    out.push({
      key: 'compliance:contract-duties',
      domain: 'compliance',
      severity: 'critical',
      label: `${duties.count} contract duties overdue, the oldest due ${duties.oldestDue ? dayWords(duties.oldestDue, now) : '—'}`,
      // Worded for every tenant: a hotel has contracts but no "clients" (hotel-journey E2E).
      detail: 'Do each one as the contract asks, then confirm it on the scorecard.',
      stakes: null,
      ageDays: duties.items[0]?.daysOverdue ?? null,
      linkUrl: '/compliance?tab=scorecard',
    });
    return;
  }
  for (const d of duties.items) {
    out.push({
      key: `compliance:contract-duty:${d.key}:${d.periodStart}`,
      domain: 'compliance',
      severity: d.daysOverdue > 7 ? 'critical' : 'high',
      // The title names the duty, its day and how overdue — one phrase, no second chip.
      label: `${d.label} — ${dueWords(d.dueDate, now)}`,
      detail: 'Overdue under the contract. Do it as the contract asks, then confirm it on the scorecard.',
      stakes: null,
      ageDays: d.daysOverdue,
      dueDay: d.dueDate.slice(0, 10),
      linkUrl: '/compliance?tab=scorecard',
    });
  }
}

/** More than this many dated records of one kind fold into a single summary item. */
const PER_RECORD_CAP = 5;

/**
 * The HR desk's legal clocks, one item a record (role walk HR 2): an
 * E-Verify mismatch opens that person's case; an unemployment claim says
 * "respond by"; a leave case says when its notice is owed; onboarding
 * drafts idle a week fold into one item. Each list past PER_RECORD_CAP
 * becomes one summary linking the filtered list instead.
 */
async function pushLegalDeadlines(
  prisma: PrismaClient,
  can: (c: Capability) => boolean,
  out: RoleDecision[],
  now: Date,
): Promise<void> {
  const tenantId = tenantIdForWrite();
  // A claim's response date is a calendar day (date-only); a leave notice's
  // is counted from an instant, so it is read on the company's clock first.
  const day = (d: Date, dateOnly = true) => dayWords(dateOnly ? d : ymd(d), now);
  const ageOf = (d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));

  if (can('manage:compliance')) {
    const tncs = await prisma.i9Verification.findMany({
      where: {
        tenantId,
        eVerifyStatus: 'TENTATIVE_NONCONFIRMATION',
        eVerifyTncDecision: null,
        associate: { deletedAt: null, separatedAt: null },
      },
      orderBy: { eVerifyCaseOpenedAt: 'asc' },
      select: { associateId: true, eVerifyCaseOpenedAt: true, associate: { select: { firstName: true, lastName: true } } },
      take: 50,
    });
    if (tncs.length > PER_RECORD_CAP) {
      out.push({
        key: 'everify:tnc',
        domain: 'compliance',
        severity: 'critical',
        label: `${tncs.length} E-Verify mismatches to act on`,
        detail: 'Give each employee the notice and record whether they will take action — the federal clock is running.',
        stakes: null,
        ageDays: null,
        linkUrl: '/compliance?tab=everify&status=issue',
      });
    } else {
      for (const t of tncs) {
        out.push({
          key: `everify:tnc:${t.associateId}`,
          domain: 'compliance',
          severity: 'critical',
          label: `E-Verify mismatch for ${t.associate.firstName} ${t.associate.lastName}`,
          detail: 'Give them the further-action notice and record whether they will take action — the federal clock is running.',
          stakes: null,
          ageDays: t.eVerifyCaseOpenedAt ? ageOf(t.eVerifyCaseOpenedAt) : null,
          linkUrl: `/compliance?tab=everify&associateId=${t.associateId}`,
        });
      }
    }
  }

  if (can('manage:claims')) {
    const claims = await prisma.unemploymentClaim.findMany({
      where: { tenantId, status: 'NEW', responseDueAt: { lte: new Date(now.getTime() + 7 * DAY_MS) } },
      orderBy: { responseDueAt: 'asc' },
      select: { id: true, state: true, responseDueAt: true, associate: { select: { firstName: true, lastName: true } } },
      take: 50,
    });
    if (claims.length > PER_RECORD_CAP) {
      out.push({
        key: 'claims:ui-due',
        domain: 'compliance',
        severity: 'critical',
        label: `${claims.length} unemployment claims to answer, the first by ${day(claims[0]!.responseDueAt)}`,
        detail: 'A late response loses the right to contest and can charge the claim to your account.',
        stakes: null,
        ageDays: null,
        linkUrl: '/claims/unemployment',
      });
    } else {
      for (const c of claims) {
        const late = c.responseDueAt.getTime() < now.getTime() - DAY_MS;
        out.push({
          key: `claims:ui:${c.id}`,
          domain: 'compliance',
          severity: late || c.responseDueAt.getTime() <= now.getTime() + 2 * DAY_MS ? 'critical' : 'high',
          // Action + record; the day in words and how far it is (F500 SH-4, 2026-10-26).
          label: `Answer ${c.associate.firstName} ${c.associate.lastName}’s ${c.state} unemployment claim — ${dueWords(c.responseDueAt, now)}`,
          detail: 'A late response loses the right to contest and can charge the claim to your account.',
          stakes: null,
          ageDays: null,
          // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: responseDueAt is a @db.Date
          dueDay: c.responseDueAt.toISOString().slice(0, 10),
          linkUrl: `/claims/unemployment?claim=${c.id}`,
        });
      }
    }
  }

  if (can('manage:leave')) {
    const soon = new Date(now.getTime() + 3 * DAY_MS);
    const cases = await prisma.leaveCase.findMany({
      where: {
        tenantId,
        OR: [
          { status: 'REQUESTED', noticeSentAt: null },
          { status: 'PENDING_CERTIFICATION', certificationReceivedAt: null, certificationDueAt: { lte: soon } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        certificationDueAt: true,
        associate: { select: { firstName: true, lastName: true } },
      },
      take: 50,
    });
    // FMLA: the eligibility notice within 5 business days of the request.
    const dueOf = (c: (typeof cases)[number]) => (c.status === 'REQUESTED' ? addBusinessDays(c.createdAt, 5) : c.certificationDueAt!);
    if (cases.length > PER_RECORD_CAP) {
      out.push({
        key: 'leave:notices',
        domain: 'compliance',
        severity: 'high',
        label: `${cases.length} leave cases with a notice or certification due`,
        detail: 'Eligibility notices are owed within 5 business days of the request.',
        stakes: null,
        ageDays: null,
        linkUrl: '/leave',
      });
    } else {
      for (const c of cases) {
        const due = dueOf(c);
        const who = `${c.associate.firstName} ${c.associate.lastName}`;
        out.push({
          key: `leave:notice:${c.id}`,
          domain: 'compliance',
          severity: due.getTime() < now.getTime() ? 'critical' : 'high',
          // A deadline that passed reads "was due … · N days overdue", never "by Fri, Oct 23" three days later.
          label:
            c.status === 'REQUESTED'
              ? `Send ${who} the leave notice — ${dueWords(ymd(due), now)}`
              : `Get ${who}’s medical certification — ${dueWords(due, now)}`,
          // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: certificationDueAt is a @db.Date (the notice day is an instant, so ymd)
          dueDay: c.status === 'REQUESTED' ? ymd(due) : due.toISOString().slice(0, 10),
          detail:
            c.status === 'REQUESTED'
              ? 'The eligibility and rights notice is owed within 5 business days of the request.'
              : 'Follow up now — the leave cannot be designated without it.',
          stakes: null,
          ageDays: ageOf(c.createdAt),
          linkUrl: `/leave?case=${c.id}`,
        });
      }
    }
  }

  if (can('manage:onboarding')) {
    // Stuck by the one rule (lib/applicationFilters) — the list's "Stuck" chip.
    const idle = await prisma.application.count({
      where: { AND: [{ tenantId, deletedAt: null }, stuckWhere(now)] },
    });
    if (idle > 0) {
      out.push({
        key: 'onboarding:idle-drafts',
        domain: 'hiring',
        severity: idle >= 5 ? 'high' : 'normal',
        label: `${idle} onboarding application${idle === 1 ? '' : 's'} stuck more than 7 days`,
        detail: 'No task done and no invite in a week — a nudge now keeps the start date.',
        stakes: null,
        ageDays: null,
        linkUrl: '/onboarding?status=STUCK',
      });
    }
  }
}
