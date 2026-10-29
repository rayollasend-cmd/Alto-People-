import type { Prisma, PrismaClient } from '@prisma/client';
import { ageOn, evaluateSchedule, localParts, type ScheduleShift } from './laborRules/evaluate.js';
import { loadLiveRules } from './laborRules/live.js';
import { loadRulePool, rulesForSite } from './laborRules/store.js';
import { startOfWeekForSite, companyWorkweek } from './timeAnomalies.js';

/**
 * The labor-rules engine at the publish gate (audit Tier 1 #11, scheduling
 * part). `evaluateSchedule` (lib/laborRules/evaluate) had no caller, so a
 * 15-year-old's 10-hour school day or an 11-hour "clopening" in New York
 * City published without a word. This runs it over every draft about to
 * go live, under the site's rules — the live activation when the
 * jurisdiction is live, else the resolved pool, exactly as
 * lib/predictabilityPay resolves — and hands back what the engine says:
 * minors' limits block (owner's decision 7, not overridable); rest and
 * overtime block or warn as the rule set's severity says.
 *
 *   Publish-week refuses the whole batch on any block (nothing publishes,
 *   the review sheet names each shift); the preflight shows the same
 *   findings before the button, so the manager fixes them first.
 *
 *   The notice rule (PREDICTIVE_NOTICE) is left out: publish-week already
 *   gates it with `lateNoticeReason`, and the engine's row would say the
 *   same thing twice.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface DraftForGuard {
  id: string;
  startsAt: Date;
  endsAt: Date;
  locationId: string | null;
  assignedAssociateId: string | null;
  assignedAssociate?: { firstName: string; lastName: string } | null;
}

export interface LaborFinding {
  rule: string;
  severity: 'warn' | 'block';
  reason: string;
  shiftId: string;
  associateId: string | null;
  associateName: string | null;
}

const WEEK_PAD_MS = 8 * 24 * 3_600_000;

export async function evaluateDraftsForPublish(
  db: Db,
  input: { tenantId: string; drafts: readonly DraftForGuard[]; now?: Date },
): Promise<LaborFinding[]> {
  const now = input.now ?? new Date();
  // Only an assigned draft has a person whose week, rest and age the rules
  // speak to; an open draft is evaluated when someone takes it (/assign).
  const assigned = input.drafts.filter((d) => d.assignedAssociateId && d.locationId);
  if (assigned.length === 0) return [];

  const siteIds = [...new Set(assigned.map((d) => d.locationId!))];
  const associateIds = [...new Set(assigned.map((d) => d.assignedAssociateId!))];
  const minStart = new Date(Math.min(...assigned.map((d) => d.startsAt.getTime())) - WEEK_PAD_MS);
  const maxEnd = new Date(Math.max(...assigned.map((d) => d.endsAt.getTime())) + WEEK_PAD_MS);

  const [sites, people, existing, live] = await Promise.all([
    db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, state: true, city: true, timezone: true } }),
    db.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, dob: true, firstName: true, lastName: true } }),
    // Their LIVE shifts around the window — the week the draft lands in,
    // and the day either side for the rest rule. Drafts are added below
    // from the batch itself (they publish together).
    db.shift.findMany({
      where: {
        assignedAssociateId: { in: associateIds },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { lt: maxEnd },
        endsAt: { gt: minStart },
      },
      select: { id: true, assignedAssociateId: true, startsAt: true, endsAt: true, locationRel: { select: { timezone: true } } },
      take: 5000,
    }),
    loadLiveRules(db, input.tenantId),
  ]);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const personById = new Map(people.map((p) => [p.id, p]));
  const draftIds = new Set(input.drafts.map((d) => d.id));
  let pool: Awaited<ReturnType<typeof loadRulePool>> | null = null;

  const byPerson = new Map<string, ScheduleShift[]>();
  const push = (associateId: string, s: ScheduleShift) => {
    const list = byPerson.get(associateId) ?? [];
    list.push(s);
    byPerson.set(associateId, list);
  };
  for (const s of existing) {
    if (draftIds.has(s.id)) continue;
    push(s.assignedAssociateId!, { startsAt: s.startsAt, endsAt: s.endsAt, timezone: s.locationRel?.timezone ?? companyWorkweek().timezone });
  }
  const draftShift = (d: DraftForGuard): ScheduleShift => ({
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    timezone: siteById.get(d.locationId!)?.timezone ?? companyWorkweek().timezone,
  });

  const out: LaborFinding[] = [];
  for (const d of assigned) {
    const site = siteById.get(d.locationId!);
    const person = personById.get(d.assignedAssociateId!);
    if (!site || !person) continue;
    const draft = draftShift(d);
    const date = localParts(d.startsAt, site.timezone).date;
    const rules = live.rulesFor(site, date) ?? rulesForSite((pool ??= await loadRulePool(db, input.tenantId)), site, date);
    // The person's other shifts: live ones, plus the batch's other drafts for them.
    const others = [
      ...(byPerson.get(d.assignedAssociateId!) ?? []),
      ...assigned.filter((o) => o.id !== d.id && o.assignedAssociateId === d.assignedAssociateId).map(draftShift),
    ];
    const findings = evaluateSchedule(draft, {
      rules,
      existing: others,
      weekStart: (at, tz) => startOfWeekForSite(at, tz),
      age: person.dob ? ageOn(person.dob, date) : null,
      now,
    });
    const name = d.assignedAssociate ? `${d.assignedAssociate.firstName} ${d.assignedAssociate.lastName}` : `${person.firstName} ${person.lastName}`;
    for (const f of findings) {
      if (f.rule === 'PREDICTIVE_NOTICE') continue;
      out.push({ rule: f.rule, severity: f.severity, reason: f.reason, shiftId: d.id, associateId: d.assignedAssociateId, associateName: name });
    }
  }
  // Blocks first, then by shift, so the review sheet reads top-down.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
}

export const hasBlock = (findings: readonly LaborFinding[]): boolean => findings.some((f) => f.severity === 'block');
