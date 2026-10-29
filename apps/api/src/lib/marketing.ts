import type { Prisma, PrismaClient } from '@prisma/client';
import { rolesWithCapability } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { sourceKey } from './recruitingAnalytics.js';
import { tenantIdForWrite } from './tenant.js';
import { orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * Marketing's numbers and the referral bonus that becomes a paycheck line.
 *
 * The funnel is read from what the product already records — the careers
 * site's view beacon (CareersPageView), candidates and their source,
 * interviews, hires, the month's spend per source — never from a stored
 * aggregate. The referral bonus is the one write that moves money, and it
 * moves it in two steps on purpose: marketing proposes, Finance approves
 * and attaches it to a payroll run as a BONUS add-on line.
 */

const DAY = 86_400_000;
const STAGE_RANK: Record<string, number> = { APPLIED: 0, SCREENING: 1, INTERVIEW: 2, OFFER: 3, HIRED: 4 };

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const money = (n: number) => Math.round(n * 100) / 100;

/** The first of a YYYY-MM-DD's month, as the Date a @db.Date column holds. */
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface SourceFunnelRow {
  source: string | null;
  views: number;
  applicants: number;
  interviewed: number;
  hires: number;
  viewToApplyPct: number | null;
  applyToHirePct: number | null;
  spend: number | null;
  costPerHire: number | null;
  /** Of this source's hires old enough to have had 90 days, the share still here. */
  retained90Pct: number | null;
}

export interface MarketingOverview {
  range: { from: string; to: string };
  funnel: { views: number; applicants: number; interviewed: number; hires: number };
  bySource: SourceFunnelRow[];
  byPosting: Array<{ slug: string; title: string; status: string; views: number; applicants: number; hires: number }>;
  weekly: Array<{ weekStart: string; views: number; applicants: number; hires: number }>;
  campaigns: { active: number; referrals: number; referralHires: number; bonusesProposed: number; bonusesApproved: number };
}

export async function computeMarketingOverview(
  input: { from: Date; to: Date; now?: Date },
  prisma: PrismaClient = defaultPrisma,
): Promise<MarketingOverview> {
  const { from, to } = input;
  const now = input.now ?? new Date();
  const tenantId = tenantIdForWrite();
  const retentionCutoff = new Date(now.getTime() - 90 * DAY);

  const [views, candidates, interviewedIds, spend, postings, campaignsActive, referrals, payouts] = await Promise.all([
    prisma.careersPageView.findMany({
      where: { tenantId, day: { gte: from, lt: to } },
      select: { slug: true, source: true, day: true, count: true },
    }),
    prisma.candidate.findMany({
      where: { tenantId, deletedAt: null, createdAt: { gte: from, lt: to } },
      select: {
        id: true,
        source: true,
        stage: true,
        createdAt: true,
        hiredAt: true,
        jobPosting: { select: { slug: true } },
        hiredAssociateId: true,
      },
    }),
    prisma.interview.findMany({
      where: { candidate: { tenantId, deletedAt: null, createdAt: { gte: from, lt: to } } },
      select: { candidateId: true },
      distinct: ['candidateId'],
    }),
    prisma.recruitingSourceSpend.findMany({
      where: { tenantId, month: { gte: monthStart(from), lte: monthStart(to) } },
      select: { source: true, amount: true },
    }),
    prisma.jobPosting.findMany({
      where: { tenantId, OR: [{ status: 'OPEN' }, { closedAt: { gte: from } }] },
      select: { slug: true, title: true, status: true },
      take: 200,
    }),
    prisma.referralCampaign.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.referral.findMany({
      where: { tenantId, createdAt: { gte: from, lt: to } },
      select: { status: true },
    }),
    prisma.referralBonusPayout.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
  ]);

  // Retention: hired associates from this range that have had 90 days.
  const measured = candidates.filter((c) => c.hiredAt && c.hiredAssociateId && c.hiredAt <= retentionCutoff);
  const separated = measured.length
    ? await prisma.associate.findMany({
        where: { id: { in: measured.map((c) => c.hiredAssociateId!) } },
        select: { id: true, separatedAt: true, deletedAt: true },
      })
    : [];
  const stayed = new Set(
    separated
      .filter((a) => {
        const c = measured.find((m) => m.hiredAssociateId === a.id)!;
        const gone = a.deletedAt ?? a.separatedAt;
        return !gone || gone.getTime() - c.hiredAt!.getTime() >= 90 * DAY;
      })
      .map((a) => a.id),
  );

  const interviewed = new Set(interviewedIds.map((i) => i.candidateId));
  const viewsBySource = new Map<string | null, number>();
  const viewsBySlug = new Map<string, number>();
  const viewsByWeek = new Map<string, number>();
  for (const v of views) {
    const s = sourceKey(v.source) ?? null;
    viewsBySource.set(s, (viewsBySource.get(s) ?? 0) + v.count);
    if (v.slug) viewsBySlug.set(v.slug, (viewsBySlug.get(v.slug) ?? 0) + v.count);
    const wk = weekKey(dateColumnKey(v.day));
    viewsByWeek.set(wk, (viewsByWeek.get(wk) ?? 0) + v.count);
  }
  const spendBySource = new Map<string | null, number>();
  for (const s of spend) {
    const k = sourceKey(s.source);
    spendBySource.set(k, (spendBySource.get(k) ?? 0) + Number(s.amount));
  }

  type Agg = { applicants: number; interviewed: number; hires: number; measured: number; stayed: number };
  const bySource = new Map<string | null, Agg>();
  const bySlug = new Map<string, { applicants: number; hires: number }>();
  const appliedByWeek = new Map<string, number>();
  const hiresByWeek = new Map<string, number>();
  const agg = (k: string | null): Agg => {
    let a = bySource.get(k);
    if (!a) {
      a = { applicants: 0, interviewed: 0, hires: 0, measured: 0, stayed: 0 };
      bySource.set(k, a);
    }
    return a;
  };
  for (const c of candidates) {
    const s = sourceKey(c.source);
    const a = agg(s);
    a.applicants += 1;
    if (interviewed.has(c.id) || (STAGE_RANK[c.stage] ?? 0) >= 2) a.interviewed += 1;
    if (c.stage === 'HIRED') a.hires += 1;
    if (c.hiredAt && c.hiredAssociateId && c.hiredAt <= retentionCutoff) {
      a.measured += 1;
      if (stayed.has(c.hiredAssociateId)) a.stayed += 1;
    }
    if (c.jobPosting?.slug) {
      const p = bySlug.get(c.jobPosting.slug) ?? { applicants: 0, hires: 0 };
      p.applicants += 1;
      if (c.stage === 'HIRED') p.hires += 1;
      bySlug.set(c.jobPosting.slug, p);
    }
    const wk = weekKey(orgDateKey(c.createdAt));
    appliedByWeek.set(wk, (appliedByWeek.get(wk) ?? 0) + 1);
    if (c.hiredAt && c.hiredAt >= from && c.hiredAt < to) {
      const hk = weekKey(orgDateKey(c.hiredAt));
      hiresByWeek.set(hk, (hiresByWeek.get(hk) ?? 0) + 1);
    }
  }
  const sources = new Set<string | null>([...viewsBySource.keys(), ...bySource.keys(), ...spendBySource.keys()]);
  const rows: SourceFunnelRow[] = [...sources]
    .map((source) => {
      const a = bySource.get(source) ?? { applicants: 0, interviewed: 0, hires: 0, measured: 0, stayed: 0 };
      const v = viewsBySource.get(source) ?? 0;
      const sp = spendBySource.has(source) ? money(spendBySource.get(source)!) : null;
      return {
        source,
        views: v,
        applicants: a.applicants,
        interviewed: a.interviewed,
        hires: a.hires,
        viewToApplyPct: pct(a.applicants, v),
        applyToHirePct: pct(a.hires, a.applicants),
        spend: sp,
        costPerHire: sp !== null && a.hires > 0 ? money(sp / a.hires) : null,
        retained90Pct: pct(a.stayed, a.measured),
      };
    })
    .sort((x, y) => y.hires - x.hires || y.applicants - x.applicants || y.views - x.views);

  const weeks = new Set<string>([...viewsByWeek.keys(), ...appliedByWeek.keys(), ...hiresByWeek.keys()]);
  const weekly = [...weeks]
    .sort()
    .map((weekStart) => ({
      weekStart,
      views: viewsByWeek.get(weekStart) ?? 0,
      applicants: appliedByWeek.get(weekStart) ?? 0,
      hires: hiresByWeek.get(weekStart) ?? 0,
    }));

  const payoutCount = (status: string) => payouts.find((p) => p.status === status)?._count._all ?? 0;
  const totals = rows.reduce(
    (t, r) => ({ views: t.views + r.views, applicants: t.applicants + r.applicants, interviewed: t.interviewed + r.interviewed, hires: t.hires + r.hires }),
    { views: 0, applicants: 0, interviewed: 0, hires: 0 },
  );
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    funnel: totals,
    bySource: rows,
    byPosting: postings
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        status: p.status,
        views: viewsBySlug.get(p.slug) ?? 0,
        applicants: bySlug.get(p.slug)?.applicants ?? 0,
        hires: bySlug.get(p.slug)?.hires ?? 0,
      }))
      .sort((a, b) => b.applicants - a.applicants || b.views - a.views),
    weekly,
    campaigns: {
      active: campaignsActive,
      referrals: referrals.length,
      referralHires: referrals.filter((r) => r.status === 'HIRED').length,
      bonusesProposed: payoutCount('PROPOSED'),
      bonusesApproved: payoutCount('APPROVED'),
    },
  };
}

/** Monday of the week containing a calendar day (YYYY-MM-DD), as YYYY-MM-DD. */
function weekKey(day: string): string {
  const dow = (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  return addDaysToKey(day, -dow);
}

/* ===== Referral bonuses ==================================================== */

export type ProposeOutcome =
  | { ok: true; payoutId: string; created: boolean }
  | { ok: false; reason: 'not_hired' | 'no_associate' | 'no_bonus' | 'too_soon' };

/**
 * Put the referrer's bonus in front of Finance: once the referred person
 * has been hired and the campaign's waiting period has passed. Idempotent
 * — a referral has one payout. `force` skips the waiting period (a manager
 * deciding the hire has clearly stuck).
 */
export async function proposeReferralBonus(
  referralId: string,
  actorUserId: string | null,
  opts: { force?: boolean; now?: Date } = {},
  prisma: PrismaClient = defaultPrisma,
): Promise<ProposeOutcome> {
  const now = opts.now ?? new Date();
  const r = await prisma.referral.findUnique({
    where: { id: referralId },
    include: {
      campaign: true,
      bonusPayout: { select: { id: true } },
      referrer: { select: { associateId: true, email: true } },
      candidate: { select: { stage: true, hiredAt: true } },
    },
  });
  if (!r) throw new Error('referral not found');
  if (r.bonusPayout) return { ok: true, payoutId: r.bonusPayout.id, created: false };
  const hired = r.status === 'HIRED' || r.candidate?.stage === 'HIRED';
  if (!hired) return { ok: false, reason: 'not_hired' };
  if (!r.referrer.associateId) return { ok: false, reason: 'no_associate' };
  const amount = r.campaign ? Number(r.campaign.bonusAmount) : r.bonusAmount ? Number(r.bonusAmount) : 0;
  if (!(amount > 0)) return { ok: false, reason: 'no_bonus' };
  const waitDays = r.campaign?.payAfterDays ?? 0;
  const hiredAt = r.candidate?.hiredAt ?? r.updatedAt;
  if (!opts.force && waitDays > 0 && now.getTime() - hiredAt.getTime() < waitDays * DAY) {
    return { ok: false, reason: 'too_soon' };
  }
  const payout = await prisma.referralBonusPayout.create({
    data: {
      referralId: r.id,
      campaignId: r.campaignId,
      associateId: r.referrer.associateId,
      amount,
      currency: r.campaign?.currency ?? r.bonusCurrency,
      proposedById: actorUserId,
      note: r.campaign ? `${r.campaign.name} — ${r.candidateName}` : `Referral of ${r.candidateName}`,
    },
  });
  // Finance decides. Everyone who can run payroll hears about it once.
  const finance = await prisma.user.findMany({
    where: { role: { in: rolesWithCapability('process:payroll') }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
    take: 50,
  });
  await Promise.all(
    finance.map((u) =>
      notifyUser(u.id, {
        subject: `Referral bonus to approve: ${fmtMoney(amount)}`,
        body: `${r.referrer.email} referred ${r.candidateName}, now hired. Approve it and it joins the next payroll run as a bonus line.`,
        category: 'payroll',
        linkUrl: '/marketing/bonuses',
      }),
    ),
  );
  return { ok: true, payoutId: payout.id, created: true };
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export type PayoutWhere = Prisma.ReferralBonusPayoutWhereInput;
