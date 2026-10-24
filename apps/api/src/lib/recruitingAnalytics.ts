import type { Prisma } from '@prisma/client';
import type { RecruitingAnalytics, RecruitingFlow } from '@alto-people/shared';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';

/**
 * The recruiting dashboard's numbers, computed from what recruiting
 * already records — no stored aggregates.
 *
 * FUNNEL: candidates who applied in the range, and how far each got on
 * their current journey (see journeyOf). A rejected candidate still counts
 * as having reached Interview if their timeline says they did — the
 * current stage alone would lose that — but an undone hire is not a hire,
 * and a re-applicant's earlier journey doesn't count.
 *
 * FLOW: the same cohort and the same journeys drawn as a flow — how many
 * reached each step (the funnel's numbers), and where and how everyone not
 * hired stopped.
 *
 * SPEED: time to hire runs from application to hire, for hires in the
 * range. Time to fill runs from the day a posting opened to the hire that
 * filled its last opening, for postings filled in the range.
 *
 * SOURCES: applicants and hires by source, and cost per hire from the
 * spend recorded for every month the range touches.
 *
 * CLIENTS: offer acceptance (accepted of accepted + declined + expired)
 * and fill rate (hires against the openings on postings opened in the
 * range), per client.
 *
 * RETENTION: of the people hired through recruiting in the latest twelve
 * months that have had 90 days, who was still here 90 days on — by the
 * source they came from and by who hired them. The same survival rule as
 * the Retention analytics: not separated, or separated 90+ days after
 * their hire date.
 */

const DAY = 86_400_000;
const PIPELINE = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'] as const;
const RANK: Record<string, number> = { APPLIED: 0, SCREENING: 1, INTERVIEW: 2, OFFER: 3, HIRED: 4 };
const OPEN_STAGES = new Set(['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER']);

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);
const money = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

/** One key per source however it was typed: "Indeed" and "indeed " are one. */
export function sourceKey(raw: string | null): string | null {
  const k = raw?.trim().toLowerCase();
  return k ? k : null;
}

/** The first of a YYYY-MM-DD's month, as the Date a @db.Date column holds. */
function monthOf(ymd: string): Date {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

function tally<K>(map: Map<K, number>, key: K, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

type JourneyEvent = { kind: string; toStage: string | null; metadata: Prisma.JsonValue };
export type FlowOutcome = 'HIRED' | 'REJECTED' | 'WITHDRAWN' | 'OPEN';

/**
 * Where a candidate's CURRENT journey got to, and how it ended — the funnel
 * and the flow both count from it. `events` are their STAGE_CHANGED, HIRED,
 * HIRE_UNDONE and RESTORED events, oldest first.
 *
 * - furthest: the highest step reached (0 Applied … 4 Hired), counting the
 *   current stage. A step skipped on the way (Applied straight to Interview)
 *   counts as passed through.
 * - A re-application after removal (RESTORED with a toStage — the careers
 *   page puts them back at Applied) starts a new journey: what came before
 *   no longer counts. A recruiter's restore (no toStage) picks up where the
 *   candidate left off, so the history stands.
 * - An undone hire (HIRE_UNDONE) is not a hire: the journey falls back to
 *   the furthest it got before the hire, or the stage the undo returned them
 *   to (Offer, as a rule), whichever is further.
 * - Only a candidate hired now ends at Hired; anyone else stops at Offer at
 *   the latest, so every applicant lands exactly once — hired, or in one exit.
 * - outcome: from the current stage. Withdrawn includes the quiet-candidate
 *   sweep (lib/recruitingCleanup), flagged `autoClosed` when the move that
 *   withdrew them was automatic.
 */
export function journeyOf(
  stage: string,
  events: readonly JourneyEvent[],
): { furthest: number; outcome: FlowOutcome; autoClosed: boolean } {
  let furthest = 0;
  let beforeHire = 0;
  let autoClosed = false;
  for (const e of events) {
    const rank = e.toStage ? RANK[e.toStage] : undefined;
    if (e.kind === 'RESTORED') {
      if (rank === undefined) continue;
      furthest = beforeHire = rank;
      autoClosed = false;
    } else if (e.kind === 'HIRE_UNDONE') {
      furthest = Math.max(furthest === 4 ? beforeHire : furthest, rank ?? RANK.OFFER!);
    } else if (e.kind === 'HIRED' || e.toStage === 'HIRED') {
      if (furthest < 4) beforeHire = furthest;
      furthest = 4;
    } else if (e.kind === 'STAGE_CHANGED') {
      if (rank !== undefined) furthest = Math.max(furthest, rank);
      if (e.toStage === 'WITHDRAWN') {
        const m = e.metadata;
        autoClosed = !!m && typeof m === 'object' && !Array.isArray(m) && m.automatic === true;
      }
    }
  }
  if (stage === 'HIRED') return { furthest: 4, outcome: 'HIRED', autoClosed: false };
  furthest = Math.min(Math.max(furthest, RANK[stage] ?? 0), RANK.OFFER!);
  if (stage === 'REJECTED') return { furthest, outcome: 'REJECTED', autoClosed: false };
  if (stage === 'WITHDRAWN') return { furthest, outcome: 'WITHDRAWN', autoClosed };
  return { furthest, outcome: 'OPEN', autoClosed: false };
}

const FLOW_STEPS = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] as const;
const FLOW_OUTCOMES = ['REJECTED', 'WITHDRAWN', 'OPEN'] as const;

export async function computeRecruitingAnalytics(input: {
  /** Start of the first day, inclusive. */
  from: Date;
  /** Start of the day after the last, exclusive. */
  to: Date;
  fromKey: string;
  toKey: string;
  now?: Date;
}): Promise<RecruitingAnalytics> {
  const { from, to, fromKey, toKey } = input;
  const now = input.now ?? new Date();
  const inRange = (d: Date | null | undefined) => !!d && d >= from && d < to;

  // The latest twelve months of hires that have all had 90 days.
  const retentionTo = new Date(now.getTime() - 90 * DAY);
  const retentionFrom = new Date(retentionTo.getTime() - 365 * DAY);

  const [cohort, hires, postings, offers, spend, retained] = await Promise.all([
    prisma.candidate.findMany({
      where: { deletedAt: null, createdAt: { gte: from, lt: to } },
      select: {
        source: true,
        stage: true,
        events: {
          where: { kind: { in: ['STAGE_CHANGED', 'HIRED', 'HIRE_UNDONE', 'RESTORED'] } },
          // Oldest first: journeyOf replays them. Events written in one
          // transaction share its timestamp, but no write records two of these.
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { kind: true, toStage: true, metadata: true },
        },
      },
    }),
    prisma.candidate.findMany({
      where: { deletedAt: null, stage: 'HIRED', hiredAt: { gte: from, lt: to } },
      select: { source: true, createdAt: true, hiredAt: true, hiredClientId: true },
    }),
    prisma.jobPosting.findMany({
      where: { openedAt: { not: null, lt: to } },
      select: {
        clientId: true,
        openings: true,
        openedAt: true,
        candidates: {
          where: { deletedAt: null, stage: 'HIRED', hiredAt: { not: null } },
          select: { hiredAt: true },
          orderBy: { hiredAt: 'asc' },
        },
      },
    }),
    prisma.offer.findMany({
      where: {
        candidate: { deletedAt: null },
        OR: [
          { status: { in: ['ACCEPTED', 'DECLINED'] }, decidedAt: { gte: from, lt: to } },
          { status: 'EXPIRED' },
          // Past its expiry, never answered, not yet swept to EXPIRED.
          { status: 'SENT', expiresAt: { lt: now } },
        ],
      },
      select: { status: true, clientId: true, decidedAt: true, expiresAt: true },
    }),
    prisma.recruitingSourceSpend.findMany({
      where: { month: { gte: monthOf(fromKey), lte: monthOf(toKey) } },
      select: { source: true, amount: true },
    }),
    prisma.candidate.findMany({
      where: {
        deletedAt: null,
        stage: 'HIRED',
        hiredAssociateId: { not: null },
        // Broad on purpose: the hire date that counts is the associate's
        // own, which can trail the day they were marked hired.
        hiredAt: { gte: new Date(retentionFrom.getTime() - 120 * DAY) },
      },
      select: { id: true, source: true, hiredAt: true, hiredAssociateId: true },
    }),
  ]);

  /* ----- Funnel ----- */
  const reached = [0, 0, 0, 0, 0];
  let rejected = 0;
  let withdrawn = 0;
  let inProgress = 0;
  const cohortHiredBySource = new Map<string | null, number>();
  const applicantsBySource = new Map<string | null, number>();
  const flowExits = new Map<string, { count: number; autoClosed: number }>();
  for (const c of cohort) {
    // One journey per candidate for the funnel and the flow, so the two
    // cards on the page always agree.
    const j = journeyOf(c.stage, c.events);
    for (let i = 0; i <= j.furthest; i++) reached[i]! += 1;
    if (c.stage === 'REJECTED') rejected += 1;
    else if (c.stage === 'WITHDRAWN') withdrawn += 1;
    else if (OPEN_STAGES.has(c.stage)) inProgress += 1;
    const key = sourceKey(c.source);
    tally(applicantsBySource, key);
    if (c.stage === 'HIRED') tally(cohortHiredBySource, key);
    if (j.outcome !== 'HIRED') {
      const k = `${FLOW_STEPS[j.furthest]}:${j.outcome}`;
      const x = flowExits.get(k) ?? { count: 0, autoClosed: 0 };
      x.count += 1;
      if (j.autoClosed) x.autoClosed += 1;
      flowExits.set(k, x);
    }
  }
  const stages = PIPELINE.map((stage, i) => ({
    stage,
    reached: reached[i]!,
    toNextPct: i < PIPELINE.length - 1 ? pct(reached[i + 1]!, reached[i]!) : null,
  }));
  const flow: RecruitingFlow = {
    reached: {
      APPLIED: reached[0]!,
      SCREENING: reached[1]!,
      INTERVIEW: reached[2]!,
      OFFER: reached[3]!,
      HIRED: reached[4]!,
    },
    exits: FLOW_STEPS.flatMap((stage) =>
      FLOW_OUTCOMES.map((outcome) => {
        const x = flowExits.get(`${stage}:${outcome}`);
        return { stage, outcome, count: x?.count ?? 0, autoClosed: x?.autoClosed ?? 0 };
      }),
    ),
  };

  /* ----- Speed, and fill ----- */
  const daysToHire = hires.map((h) => (h.hiredAt!.getTime() - h.createdAt.getTime()) / DAY);
  const hiresByClient = new Map<string, number>();
  const hiresBySource = new Map<string | null, number>();
  for (const h of hires) {
    if (h.hiredClientId) tally(hiresByClient, h.hiredClientId);
    tally(hiresBySource, sourceKey(h.source));
  }

  const daysToFill: number[] = [];
  const fillDaysByClient = new Map<string, number[]>();
  const openingsByClient = new Map<string, number>();
  const filledByClient = new Map<string, number>();
  let openings = 0;
  let filled = 0;
  for (const p of postings) {
    const openingCount = Math.max(1, p.openings);
    // The hire that filled its last opening, if it has been filled.
    const filledAt = p.candidates.length >= openingCount ? p.candidates[openingCount - 1]!.hiredAt : null;
    if (inRange(filledAt)) {
      const d = (filledAt!.getTime() - p.openedAt!.getTime()) / DAY;
      daysToFill.push(d);
      if (p.clientId) fillDaysByClient.set(p.clientId, [...(fillDaysByClient.get(p.clientId) ?? []), d]);
    }
    if (inRange(p.openedAt)) {
      const f = Math.min(p.candidates.length, openingCount);
      openings += openingCount;
      filled += f;
      if (p.clientId) {
        tally(openingsByClient, p.clientId, openingCount);
        tally(filledByClient, p.clientId, f);
      }
    }
  }

  /* ----- Offers ----- */
  let accepted = 0;
  let declined = 0;
  let expired = 0;
  const offerByClient = new Map<string, { accepted: number; decided: number }>();
  for (const o of offers) {
    let outcome: 'accepted' | 'declined' | 'expired' | null = null;
    if (o.status === 'ACCEPTED' && inRange(o.decidedAt)) outcome = 'accepted';
    else if (o.status === 'DECLINED' && inRange(o.decidedAt)) outcome = 'declined';
    else if ((o.status === 'EXPIRED' || o.status === 'SENT') && inRange(o.expiresAt ?? o.decidedAt)) outcome = 'expired';
    if (!outcome) continue;
    if (outcome === 'accepted') accepted += 1;
    else if (outcome === 'declined') declined += 1;
    else expired += 1;
    // Per-client acceptance is a client thing; a client-less offer (a direct employer) counts in the totals only.
    if (!o.clientId) continue;
    const agg = offerByClient.get(o.clientId) ?? { accepted: 0, decided: 0 };
    agg.decided += 1;
    if (outcome === 'accepted') agg.accepted += 1;
    offerByClient.set(o.clientId, agg);
  }

  /* ----- Sources and spend ----- */
  const spendBySource = new Map<string | null, number>();
  for (const s of spend) tally(spendBySource, sourceKey(s.source), Number(s.amount));
  const spendTotal = spend.length ? money([...spendBySource.values()].reduce((a, b) => a + b, 0)) : null;
  const sourceKeys = new Set<string | null>([...applicantsBySource.keys(), ...hiresBySource.keys(), ...spendBySource.keys()]);
  const sources = [...sourceKeys]
    .map((source) => {
      const applicants = applicantsBySource.get(source) ?? 0;
      const h = hiresBySource.get(source) ?? 0;
      const sp = spendBySource.has(source) ? money(spendBySource.get(source)!) : null;
      return {
        source,
        applicants,
        hires: h,
        applicantToHirePct: pct(cohortHiredBySource.get(source) ?? 0, applicants),
        spend: sp,
        costPerHire: sp !== null && h > 0 ? money(sp / h) : null,
      };
    })
    .sort((a, b) => b.hires - a.hires || b.applicants - a.applicants || (a.source ?? '~').localeCompare(b.source ?? '~'));

  /* ----- Per client ----- */
  const clientIds = new Set<string>([
    ...hiresByClient.keys(),
    ...offerByClient.keys(),
    ...openingsByClient.keys(),
    ...fillDaysByClient.keys(),
  ]);
  const clientNames = new Map(
    (
      await prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true } })
    ).map((c) => [c.id, c.name]),
  );
  const clients = [...clientIds]
    .filter((id) => clientNames.has(id))
    .map((clientId) => {
      const o = offerByClient.get(clientId) ?? { accepted: 0, decided: 0 };
      const op = openingsByClient.get(clientId) ?? 0;
      const f = filledByClient.get(clientId) ?? 0;
      return {
        clientId,
        clientName: clientNames.get(clientId)!,
        hires: hiresByClient.get(clientId) ?? 0,
        offersAccepted: o.accepted,
        offersDecided: o.decided,
        offerAcceptancePct: pct(o.accepted, o.decided),
        openings: op,
        filled: f,
        fillRatePct: pct(f, op),
        medianDaysToFill: median(fillDaysByClient.get(clientId) ?? []),
      };
    })
    .sort((a, b) => b.hires - a.hires || a.clientName.localeCompare(b.clientName));

  /* ----- 90-day retention ----- */
  const associates = await prisma.associate.findMany({
    where: { id: { in: retained.map((r) => r.hiredAssociateId!) } },
    select: { id: true, hireDate: true, separatedAt: true },
  });
  const assocById = new Map(associates.map((a) => [a.id, a]));
  const measured = retained
    .map((r) => {
      const a = assocById.get(r.hiredAssociateId!);
      if (!a) return null;
      const hired = a.hireDate ?? r.hiredAt!;
      if (hired < retentionFrom || hired >= retentionTo) return null;
      const stayed = a.separatedAt === null || a.separatedAt.getTime() - hired.getTime() >= 90 * DAY;
      return { candidateId: r.id, source: sourceKey(r.source), stayed };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // Who hired them: the person who marked them hired, from the timeline.
  const hiredEvents = await prisma.candidateEvent.findMany({
    where: { candidateId: { in: measured.map((m) => m.candidateId) }, kind: 'HIRED' },
    orderBy: { createdAt: 'desc' },
    select: {
      candidateId: true,
      actorUserId: true,
      actor: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  const hirer = new Map<string, { id: string; name: string } | null>();
  for (const e of hiredEvents) {
    if (hirer.has(e.candidateId)) continue; // newest first — keep the latest
    hirer.set(
      e.candidateId,
      e.actorUserId && e.actor
        ? {
            id: e.actorUserId,
            name: e.actor.associate ? `${e.actor.associate.firstName} ${e.actor.associate.lastName}` : e.actor.email,
          }
        : null,
    );
  }

  const group = (keyOf: (m: (typeof measured)[number]) => { key: string | null; label: string }) => {
    const rows = new Map<string, { key: string | null; label: string; hires: number; stayed: number }>();
    for (const m of measured) {
      const { key, label } = keyOf(m);
      const id = key ?? '\u0000none';
      const row = rows.get(id) ?? { key, label, hires: 0, stayed: 0 };
      row.hires += 1;
      if (m.stayed) row.stayed += 1;
      rows.set(id, row);
    }
    return [...rows.values()]
      .map((r) => ({ ...r, stayedPct: pct(r.stayed, r.hires) }))
      .sort((a, b) => b.hires - a.hires || a.label.localeCompare(b.label));
  };
  const stayedAll = measured.filter((m) => m.stayed).length;

  return {
    range: { from: fromKey, to: toKey },
    funnel: { applicants: cohort.length, stages, rejected, withdrawn, inProgress },
    flow,
    speed: {
      hires: hires.length,
      medianDaysToHire: median(daysToHire),
      postingsFilled: daysToFill.length,
      medianDaysToFill: median(daysToFill),
    },
    sources,
    spendTotal,
    costPerHire: spendTotal !== null && hires.length > 0 ? money(spendTotal / hires.length) : null,
    offers: { accepted, declined, expired, acceptancePct: pct(accepted, accepted + declined + expired) },
    fill: { openings, filled, fillRatePct: pct(filled, openings) },
    clients,
    retention: {
      window: {
        from: localDateKey(retentionFrom, DEFAULT_TIMEZONE),
        to: localDateKey(new Date(retentionTo.getTime() - 1), DEFAULT_TIMEZONE),
      },
      overall: { key: null, label: 'All hires', hires: measured.length, stayed: stayedAll, stayedPct: pct(stayedAll, measured.length) },
      bySource: group((m) => ({ key: m.source, label: m.source ?? 'Not recorded' })),
      byRecruiter: group((m) => {
        const h = hirer.get(m.candidateId);
        return h ? { key: h.id, label: h.name } : { key: null, label: 'Not recorded' };
      }),
    },
  };
}
