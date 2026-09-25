import type { CandidateStage } from '@prisma/client';
import { hasCapability, type RecruiterHome } from '@alto-people/shared';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { DEFAULT_TIMEZONE, addDaysInZone, localDateKey, zonedWallTimeToUtcInstant } from './timezone.js';
import { closingSoon } from './recruitingCleanup.js';
import { INVITE_EXPIRE_AFTER_DAYS } from './onboardingUndo.js';
import { IDLE_PURGE_AFTER_DAYS, INVITE_PURGE_AFTER_DAYS, hasProtectedHistory } from './onboardingPurge.js';

/**
 * The recruiter's dashboard, in one round trip.
 *
 * A recruiter used to land on the HR administrator's dashboard: payroll
 * totals, open shifts, a feed of everyone's sign-ins, and "All systems
 * nominal — nothing needs your decision" above a pipeline with people
 * going cold in it. This is what a recruiter's day is made of instead:
 *
 *   TODAY            the day's interviews — upcoming, done, or needing a score
 *   NEW APPLICANTS   who applied in the last day and week, and from where
 *   WAITING ON YOU   interviews to score, candidates gone quiet, clients who
 *                    said yes (make the offer), signed offers (hire them),
 *                    offers held for pay approval that are yours to approve
 *   WAITING ON OTHERS  candidates with clients, offers out for signature,
 *                    new hires who haven't started onboarding
 *   PIPELINE         open stages, and open postings with their fill
 *   NUMBERS          hires this month and last, time to hire, acceptance
 *   ACTIVITY         the latest moves across the pipeline
 */

const DAY = 86_400_000;
const OPEN_STAGES: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
const STUCK_AFTER_DAYS = 7;
const LIST = 5;

type Person = { email: string; associate: { firstName: string; lastName: string } | null } | null;
const personName = (u: Person): string | null =>
  u ? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email) : null;
const PERSON = { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } as const;
const nameOf = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`;
const LIVE = { candidate: { deletedAt: null } } as const;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 10) / 10;
}

export async function computeRecruiterHome(user: SessionUser, now = new Date()): Promise<RecruiterHome> {
  const tz = DEFAULT_TIMEZONE;
  const [y, mo, d] = localDateKey(now, tz).split('-').map(Number) as [number, number, number];
  const startOfToday = zonedWallTimeToUtcInstant(y, mo, d, 0, tz);
  const startOfTomorrow = addDaysInZone(startOfToday, 1, tz);
  const startOfMonth = zonedWallTimeToUtcInstant(y, mo, 1, 0, tz);
  const startOfLastMonth = zonedWallTimeToUtcInstant(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1, 1, 0, tz);
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const canApprovePay = hasCapability(user.role, 'manage:comp');

  const [
    interviewsToday,
    newest,
    count24h,
    sources7d,
    toScore,
    toScoreTotal,
    toScoreMine,
    stuck,
    stuckTotal,
    approved,
    signed,
    held,
    withClients,
    withClientsTotal,
    outForSignature,
    outForSignatureTotal,
    hiredRecently,
    byStage,
    postings,
    applicants7dByPosting,
    hires90,
    decided90,
    events,
    closing,
  ] = await Promise.all([
    prisma.interview.findMany({
      where: { ...LIVE, scheduledFor: { gte: startOfToday, lt: startOfTomorrow } },
      orderBy: { scheduledFor: 'asc' },
      take: 25,
      include: {
        candidate: { select: { id: true, firstName: true, lastName: true, position: true } },
        interviewer: PERSON,
      },
    }),
    prisma.candidate.findMany({
      where: { deletedAt: null, createdAt: { gte: ago(7) } },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true, firstName: true, lastName: true, position: true, source: true, createdAt: true,
        jobPosting: { select: { title: true } },
      },
    }),
    prisma.candidate.count({ where: { deletedAt: null, createdAt: { gte: ago(1) } } }),
    prisma.candidate.groupBy({
      by: ['source'],
      where: { deletedAt: null, createdAt: { gte: ago(7) } },
      _count: { _all: true },
    }),
    prisma.interview.findMany({
      where: { ...LIVE, completedAt: null, scheduledFor: { lt: now } },
      orderBy: { scheduledFor: 'asc' },
      take: 50,
      include: { candidate: { select: { id: true, firstName: true, lastName: true } }, interviewer: PERSON },
    }),
    prisma.interview.count({ where: { ...LIVE, completedAt: null, scheduledFor: { lt: now } } }),
    prisma.interview.count({ where: { ...LIVE, completedAt: null, scheduledFor: { lt: now }, interviewerUserId: user.id } }),
    prisma.candidate.findMany({
      where: { deletedAt: null, stage: { in: OPEN_STAGES }, stageChangedAt: { lt: ago(STUCK_AFTER_DAYS) } },
      orderBy: { stageChangedAt: 'asc' },
      take: LIST,
      select: { id: true, firstName: true, lastName: true, position: true, stage: true, stageChangedAt: true },
    }),
    prisma.candidate.count({
      where: { deletedAt: null, stage: { in: OPEN_STAGES }, stageChangedAt: { lt: ago(STUCK_AFTER_DAYS) } },
    }),
    prisma.candidateSubmittal.findMany({
      where: { status: 'APPROVED', decidedAt: { gte: ago(30) }, candidate: { deletedAt: null, stage: { in: OPEN_STAGES } } },
      orderBy: { decidedAt: 'desc' },
      take: 20,
      include: {
        client: { select: { name: true } },
        location: { select: { name: true } },
        candidate: {
          select: { id: true, firstName: true, lastName: true, offers: { select: { status: true, createdAt: true } } },
        },
      },
    }),
    prisma.offer.findMany({
      where: { status: 'ACCEPTED', candidate: { deletedAt: null, stage: { not: 'HIRED' } } },
      orderBy: { decidedAt: 'desc' },
      take: LIST,
      include: { client: { select: { name: true } }, candidate: { select: { id: true, firstName: true, lastName: true } } },
    }),
    canApprovePay
      ? prisma.offer.findMany({
          where: { status: 'PENDING_APPROVAL', ...LIVE, NOT: { createdById: user.id } },
          orderBy: { createdAt: 'asc' },
          take: LIST,
          include: { candidate: { select: { id: true, firstName: true, lastName: true } } },
        })
      : Promise.resolve([]),
    prisma.candidateSubmittal.findMany({
      where: { status: 'PENDING', ...LIVE },
      orderBy: { createdAt: 'asc' },
      take: LIST,
      include: {
        client: { select: { name: true } },
        location: { select: { name: true } },
        candidate: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.candidateSubmittal.count({ where: { status: 'PENDING', ...LIVE } }),
    prisma.offer.findMany({
      where: { status: 'SENT', ...LIVE },
      // Soonest to lapse first.
      orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { sentAt: 'asc' }],
      take: LIST,
      include: { candidate: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.offer.count({ where: { status: 'SENT', ...LIVE } }),
    prisma.candidate.findMany({
      where: { deletedAt: null, stage: 'HIRED', hiredAssociateId: { not: null }, hiredAt: { gte: ago(60) } },
      select: { id: true, firstName: true, lastName: true, hiredAssociateId: true },
    }),
    prisma.candidate.groupBy({
      by: ['stage'],
      where: { deletedAt: null, stage: { in: OPEN_STAGES } },
      _count: { _all: true },
    }),
    prisma.jobPosting.findMany({
      where: { status: 'OPEN' },
      include: {
        client: { select: { name: true } },
        _count: { select: { candidates: { where: { deletedAt: null } } } },
        candidates: { where: { deletedAt: null, stage: 'HIRED' }, select: { id: true } },
      },
    }),
    prisma.candidate.groupBy({
      by: ['jobPostingId'],
      where: { deletedAt: null, jobPostingId: { not: null }, createdAt: { gte: ago(7) } },
      _count: { _all: true },
    }),
    prisma.candidate.findMany({
      where: { deletedAt: null, stage: 'HIRED', hiredAt: { gte: ago(90) } },
      select: { createdAt: true, hiredAt: true },
    }),
    prisma.offer.groupBy({
      by: ['status'],
      where: { ...LIVE, status: { in: ['ACCEPTED', 'DECLINED', 'EXPIRED'] }, decidedAt: { gte: ago(90) } },
      _count: { _all: true },
    }),
    prisma.candidateEvent.findMany({
      where: { candidate: { deletedAt: null }, kind: { not: 'EDITED' } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { candidate: { select: { id: true, firstName: true, lastName: true } }, actor: PERSON },
    }),
    closingSoon(now, 500),
  ]);

  /* ----- Today ----- */
  const today = interviewsToday.map((i) => ({
    id: i.id,
    candidateId: i.candidate.id,
    candidateName: nameOf(i.candidate),
    position: i.candidate.position,
    scheduledFor: i.scheduledFor.toISOString(),
    durationMinutes: i.durationMinutes,
    location: i.location,
    interviewerName: personName(i.interviewer),
    mine: i.interviewerUserId === user.id,
    state: i.completedAt ? ('done' as const) : i.scheduledFor < now ? ('needs_score' as const) : ('upcoming' as const),
  }));

  /* ----- Waiting on you ----- */
  // Yours first, then the longest-waiting.
  const scoreItems = [...toScore]
    .sort((a, b) => Number(b.interviewerUserId === user.id) - Number(a.interviewerUserId === user.id))
    .slice(0, LIST)
    .map((i) => ({
      interviewId: i.id,
      candidateId: i.candidate.id,
      candidateName: nameOf(i.candidate),
      scheduledFor: i.scheduledFor.toISOString(),
      interviewerName: personName(i.interviewer),
      mine: i.interviewerUserId === user.id,
    }));
  // A client said yes, and no offer has been drafted, held or sent since.
  const LIVE_OFFER = new Set(['PENDING_APPROVAL', 'DRAFT', 'SENT', 'ACCEPTED']);
  const seenCandidate = new Set<string>();
  const clientApproved = approved
    .filter((s) => !s.candidate.offers.some((o) => LIVE_OFFER.has(o.status) && o.createdAt >= (s.decidedAt ?? s.createdAt)))
    .filter((s) => (seenCandidate.has(s.candidate.id) ? false : (seenCandidate.add(s.candidate.id), true)))
    .slice(0, LIST)
    .map((s) => ({
      submittalId: s.id,
      candidateId: s.candidate.id,
      candidateName: nameOf(s.candidate),
      clientName: s.client.name,
      storeName: s.location?.name ?? null,
      feedback: s.feedback,
      decidedAt: (s.decidedAt ?? s.updatedAt).toISOString(),
    }));

  /* ----- Waiting on others: new hires who haven't started onboarding ----- */
  const byAssociate = new Map(hiredRecently.map((c) => [c.hiredAssociateId!, c]));
  const drafts = byAssociate.size
    ? await prisma.application.findMany({
        where: { deletedAt: null, status: 'DRAFT', associateId: { in: [...byAssociate.keys()] } },
        orderBy: { invitedAt: 'asc' },
        include: {
          client: { select: { name: true } },
          associate: {
            select: {
              user: {
                select: {
                  passwordHash: true,
                  createdAt: true,
                  inviteTokens: { orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, mintedBySweep: true } },
                },
              },
            },
          },
          checklist: { select: { tasks: { where: { completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, take: 1, select: { completedAt: true } } } },
        },
      })
    : [];
  // When the onboarding clean-up would close each one — the same rules it
  // runs: never accepted, INVITE_PURGE_AFTER_DAYS after the last invite a
  // person sent; accepted and idle, IDLE_PURGE_AFTER_DAYS; anyone with
  // history, INVITE_EXPIRE_AFTER_DAYS untouched.
  const closesAt = new Map<string, Date>();
  for (const a of drafts.slice(0, LIST)) {
    const u = a.associate.user;
    const latest = (xs: Array<Date | null | undefined>) =>
      new Date(Math.max(...xs.filter((x): x is Date => Boolean(x)).map((x) => x.getTime())));
    const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
    const protectedHistory = await hasProtectedHistory(prisma, a.associateId);
    if (!protectedHistory && u && !u.passwordHash) {
      const human = u.inviteTokens.find((t) => !t.mintedBySweep)?.createdAt ?? u.createdAt;
      closesAt.set(a.id, plus(human, INVITE_PURGE_AFTER_DAYS));
    } else if (!protectedHistory && u?.passwordHash) {
      closesAt.set(a.id, plus(latest([a.updatedAt, a.checklist?.tasks[0]?.completedAt]), IDLE_PURGE_AFTER_DAYS));
    } else {
      closesAt.set(
        a.id,
        plus(latest([a.invitedAt, a.updatedAt, a.progressRemindedAt, u?.inviteTokens[0]?.createdAt]), INVITE_EXPIRE_AFTER_DAYS),
      );
    }
  }

  /* ----- Postings ----- */
  const fresh = new Map(applicants7dByPosting.map((g) => [g.jobPostingId, g._count._all]));
  const postingRows = postings
    .map((p) => ({
      id: p.id,
      title: p.title,
      clientName: p.client?.name ?? null,
      openings: p.openings,
      hired: p.candidates.length,
      applicants: p._count.candidates,
      applicants7d: fresh.get(p.id) ?? 0,
      daysOpen: p.openedAt ? Math.floor((now.getTime() - p.openedAt.getTime()) / DAY) : null,
    }))
    // The ones furthest from filled, longest open, first.
    .sort((a, b) => Number(a.hired >= a.openings) - Number(b.hired >= b.openings) || (b.daysOpen ?? 0) - (a.daysOpen ?? 0));

  /* ----- Numbers ----- */
  // One row per source however it was typed — "Indeed" and "indeed" are one.
  const sourceCounts = new Map<string | null, number>();
  for (const g of sources7d) {
    const k = g.source?.trim().toLowerCase() || null;
    sourceCounts.set(k, (sourceCounts.get(k) ?? 0) + g._count._all);
  }

  const decided = new Map(decided90.map((g) => [g.status, g._count._all]));
  const accepted = decided.get('ACCEPTED') ?? 0;
  const offersDecided = accepted + (decided.get('DECLINED') ?? 0) + (decided.get('EXPIRED') ?? 0);
  const stages = new Map(byStage.map((g) => [g.stage, g._count._all]));

  return {
    interviewsToday: today,
    newApplicants: {
      last24h: count24h,
      last7d: sources7d.reduce((a, g) => a + g._count._all, 0),
      bySource: [...sourceCounts]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      recent: newest.map((c) => ({
        candidateId: c.id,
        candidateName: nameOf(c),
        position: c.position,
        source: c.source,
        postingTitle: c.jobPosting?.title ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    },
    waitingOnYou: {
      toScore: { total: toScoreTotal, mine: toScoreMine, items: scoreItems },
      stuck: {
        total: stuckTotal,
        afterDays: STUCK_AFTER_DAYS,
        items: stuck.map((c) => ({
          candidateId: c.id,
          candidateName: nameOf(c),
          position: c.position,
          stage: c.stage,
          daysInStage: Math.floor((now.getTime() - c.stageChangedAt.getTime()) / DAY),
        })),
      },
      clientApproved,
      readyToHire: signed.map((o) => ({
        offerId: o.id,
        candidateId: o.candidate.id,
        candidateName: nameOf(o.candidate),
        jobTitle: o.jobTitle,
        clientName: o.client.name,
        startDate: o.startDate.toISOString().slice(0, 10),
        acceptedAt: (o.signedAt ?? o.decidedAt)?.toISOString() ?? null,
      })),
      closingSoon: {
        total: closing.length,
        // Soonest to close first.
        items: [...closing]
          .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime())
          .slice(0, LIST)
          .map((c) => ({
            candidateId: c.id,
            candidateName: nameOf(c),
            stage: c.stage,
            closesAt: c.closesAt.toISOString(),
          })),
      },
      offersToApprove: held.map((o) => ({
        offerId: o.id,
        candidateId: o.candidate.id,
        candidateName: nameOf(o.candidate),
        jobTitle: o.jobTitle,
        approvalNote: o.approvalNote,
      })),
    },
    waitingOnOthers: {
      withClients: {
        total: withClientsTotal,
        items: withClients.map((s) => ({
          submittalId: s.id,
          candidateId: s.candidate.id,
          candidateName: nameOf(s.candidate),
          clientName: s.client.name,
          storeName: s.location?.name ?? null,
          sentAt: s.createdAt.toISOString(),
          days: Math.floor((now.getTime() - s.createdAt.getTime()) / DAY),
        })),
      },
      awaitingSignature: {
        total: outForSignatureTotal,
        items: outForSignature.map((o) => ({
          offerId: o.id,
          candidateId: o.candidate.id,
          candidateName: nameOf(o.candidate),
          jobTitle: o.jobTitle,
          sentAt: o.sentAt?.toISOString() ?? null,
          expiresAt: o.expiresAt?.toISOString() ?? null,
          expiringSoon: Boolean(o.expiresAt && o.expiresAt.getTime() - now.getTime() < 3 * DAY),
        })),
      },
      onboardingNotStarted: {
        total: drafts.length,
        items: drafts.slice(0, LIST).map((a) => {
          const c = byAssociate.get(a.associateId)!;
          return {
            applicationId: a.id,
            candidateId: c.id,
            candidateName: nameOf(c),
            clientName: a.client.name,
            invitedAt: a.invitedAt.toISOString(),
            days: Math.floor((now.getTime() - a.invitedAt.getTime()) / DAY),
            closesAt: closesAt.get(a.id)?.toISOString() ?? null,
          };
        }),
      },
    },
    pipeline: {
      APPLIED: stages.get('APPLIED') ?? 0,
      SCREENING: stages.get('SCREENING') ?? 0,
      INTERVIEW: stages.get('INTERVIEW') ?? 0,
      OFFER: stages.get('OFFER') ?? 0,
    },
    postings: { total: postingRows.length, items: postingRows.slice(0, 6) },
    numbers: {
      hiresThisMonth: hires90.filter((h) => h.hiredAt! >= startOfMonth).length,
      hiresLastMonth: hires90.filter((h) => h.hiredAt! >= startOfLastMonth && h.hiredAt! < startOfMonth).length,
      medianDaysToHire: median(hires90.map((h) => (h.hiredAt!.getTime() - h.createdAt.getTime()) / DAY)),
      offerAcceptancePct: offersDecided ? Math.round((accepted / offersDecided) * 100) : null,
      offersDecided,
    },
    activity: events.map((e) => ({
      id: e.id,
      candidateId: e.candidate.id,
      candidateName: nameOf(e.candidate),
      kind: e.kind,
      fromStage: e.fromStage,
      toStage: e.toStage,
      body: e.body,
      actorName: personName(e.actor),
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
