import type { LaborRuleActivation, Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../../middleware/error.js';
import { enqueueAudit } from '../audit.js';
import { secondPersonExists } from '../approvalPolicy.js';
import { createApprovalRequest, registerApplyHandler } from '../approvalRequests.js';
import { companyWorkweek, startOfWeekForSite } from '../timeAnomalies.js';
import { tenantIdForWrite } from '../tenant.js';
import { splitWeeklyOvertime } from '../payroll.js';
import { evaluateTime, type PenaltyOutcome, type WorkEntry } from './evaluate.js';
import { SHIPPED_PACKS, jurisdictionsFor } from './packs.js';
import { resolveRules } from './resolve.js';
import { loadRulePool, rulesForSite, type StoredRuleSet } from './store.js';
import { FEDERAL_PACK } from './packs.js';
import type { ResolvedRules, RuleSetDef } from './params.js';

/**
 * Brief 2-2 step 4 — the engine pays, one jurisdiction at a time.
 *
 *   A tenant moves a state (US-CA) — or a single site — from shadow to LIVE
 *   with counsel's recorded sign-off and a second person (the approval
 *   engine). The exact rule-set rows in force at signing are pinned on the
 *   activation (signedSetIds): payroll resolves a live site's rules from
 *   those rows only, so a newer pack version, or an override edited later,
 *   is not paid until someone signs it again. Back to shadow is instant.
 *
 *   Entries at sites that are not live are paid exactly as before (the
 *   federal weekly split); a person whose period mixes live and not-live
 *   sites is evaluated once, with the not-live entries under the same
 *   federal split (breaks docked as today), so their week is counted once.
 */

type Db = PrismaClient;
/** Reads that also run inside a payroll transaction. */
type ReadDb = PrismaClient | Prisma.TransactionClient;

/** States a shipped pack covers (US-FL…), the only jurisdictions that can go live. */
export const LIVE_JURISDICTIONS: string[] = [...new Set(SHIPPED_PACKS.filter((p) => p.level === 'STATE').map((p) => p.jurisdiction))].sort();

const STATE_NAMES: Record<string, string> = {
  'US-AL': 'Alabama',
  'US-CA': 'California',
  'US-FL': 'Florida',
  'US-IL': 'Illinois',
  'US-NY': 'New York',
};
const CITY_NAMES: Record<string, string> = { 'US-NY-NYC': 'New York City', 'US-IL-CHICAGO': 'Chicago' };
export const jurisdictionLabel = (j: string) => STATE_NAMES[j] ?? CITY_NAMES[j] ?? j.replace(/^US-/, '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const humanDate = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;

/** "Federal rules · from Jul 24, 2009 · version 1" — how a person reads a rule set. */
export function setLabelForPeople(s: { jurisdiction: string; effectiveFrom: string; version: number }): string {
  const scope =
    s.jurisdiction === 'FEDERAL'
      ? 'Federal rules'
      : s.jurisdiction === 'TENANT'
        ? 'Your organization’s rules'
        : s.jurisdiction.startsWith('SITE:')
          ? 'A site’s own rules'
          : `${jurisdictionLabel(s.jurisdiction)} rules`;
  return `${scope} · from ${humanDate(s.effectiveFrom)} · version ${s.version}`;
}

export const ATTESTATION_TEXT =
  'I confirm that counsel has reviewed the rules listed here against the cited sources, and that this organization will pay the people who work in this jurisdiction by them from the date this goes live.';

/* ----- The pool a live site pays by ---------------------------------------- */

/** The rows a sign-off covers: federal, the state and its cities, the tenant's overrides, and the site's (or the state's sites') overrides. */
export function signablesFor(pool: readonly StoredRuleSet[], jurisdiction: string, siteIds: readonly string[]): StoredRuleSet[] {
  const sites = new Set(siteIds.map((id) => `SITE:${id}`));
  return pool.filter(
    (s) =>
      s.status !== 'RETIRED' &&
      (s.jurisdiction === 'FEDERAL' || s.jurisdiction === jurisdiction || s.jurisdiction.startsWith(`${jurisdiction}-`) || s.jurisdiction === 'TENANT' || sites.has(s.jurisdiction)),
  );
}

/** The signed rows, treated as signed for this tenant's pay (status ACTIVE in memory only). */
function signedPool(pool: readonly StoredRuleSet[], ids: readonly string[]): RuleSetDef[] {
  const want = new Set(ids);
  return pool.filter((s) => want.has(s.id)).map((s) => ({ ...s, status: 'ACTIVE' as const }));
}

/**
 * Today's pay, as resolved rules: the federal weekly 40 at 1.5x, every break
 * docked (no short-break rule) — what entries at a not-live site are paid by
 * when they share a week with live ones.
 */
export const TODAYS_RULES: ResolvedRules = resolveRules([
  { ...FEDERAL_PACK, status: 'ACTIVE', params: { overtime: FEDERAL_PACK.params.overtime, breaks: { paidUpToMinutes: null } } },
]);

export interface SiteRef {
  id: string;
  state: string | null;
  city: string | null;
}

export interface LiveRules {
  /** Any live activation at all (the payroll fast path skips everything otherwise). */
  any: boolean;
  /** The activation a site pays by, or null (shadow). */
  activationFor(site: SiteRef | null): LaborRuleActivation | null;
  /** Rules for a site on a date under its activation, or null when the site isn't live. */
  rulesFor(site: SiteRef | null, date: string): ResolvedRules | null;
  activations: LaborRuleActivation[];
}

const NO_LIVE: LiveRules = { any: false, activationFor: () => null, rulesFor: () => null, activations: [] };

export async function loadLiveRules(db: ReadDb, tenantId: string): Promise<LiveRules> {
  const activations = await db.laborRuleActivation.findMany({ where: { tenantId, status: 'LIVE' }, orderBy: { activatedAt: 'desc' } });
  if (activations.length === 0) return NO_LIVE;
  const pool = await loadRulePool(db, tenantId);
  const pools = new Map(activations.map((a) => [a.id, signedPool(pool, a.signedSetIds)]));
  const activationFor = (site: SiteRef | null): LaborRuleActivation | null => {
    if (!site) return null;
    const own = activations.find((a) => a.siteId === site.id);
    if (own) return own;
    const j = site.state ? `US-${site.state.toUpperCase()}` : null;
    return activations.find((a) => !a.siteId && a.jurisdiction === j) ?? null;
  };
  return {
    any: true,
    activations,
    activationFor,
    rulesFor: (site, date) => {
      const a = activationFor(site);
      return a && site ? rulesForSite(pools.get(a.id)!, site, date) : null;
    },
  };
}

/* ----- Evaluating a person's period under live rules ------------------------ */

export interface LiveEntry {
  id?: string;
  clockInAt: Date;
  clockOutAt: Date;
  breaks: Array<{ type?: 'MEAL' | 'REST' | null; startedAt: Date; endedAt: Date | null }>;
  site: (SiteRef & { timezone: string }) | null;
  mealWaived?: boolean;
}

export interface LivePay {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  overtimeMultiplier: number;
  doubleMultiplier: number;
  penalties: Array<PenaltyOutcome & { label: string }>;
  reasons: string[];
}

const PENALTY_NAME: Record<PenaltyOutcome['kind'], string> = {
  MEAL: 'Meal premium',
  REST: 'Rest premium',
  REST_BETWEEN_SHIFTS: 'Rest-between-shifts premium',
};

/** "Meal premium (US-CA 2026-01-01 v1)" — the line a paystub prints, citing the rule set. */
function penaltyLabel(p: PenaltyOutcome): string {
  const cite = /,\s*([^,]+)$/.exec(p.reason)?.[1]?.trim();
  return cite ? `${PENALTY_NAME[p.kind]} (${cite})` : PENALTY_NAME[p.kind];
}

/** One person's entries: live ones under their pinned rules, the rest as paid today. */
export function evaluateLivePay(live: LiveRules, entries: readonly LiveEntry[]): LivePay {
  const fallbackTz = companyWorkweek().timezone;
  const siteOf = new Map<WorkEntry, LiveEntry['site']>();
  const work: WorkEntry[] = entries.map((e) => {
    const w: WorkEntry = { id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, timezone: e.site?.timezone ?? fallbackTz, mealWaived: e.mealWaived };
    siteOf.set(w, e.site);
    return w;
  });
  const out = evaluateTime(work, {
    rulesFor: (w, date) => live.rulesFor(siteOf.get(w) ?? null, date) ?? TODAYS_RULES,
    weekStart: (d, tz) => startOfWeekForSite(d, tz),
  });
  return {
    regularHours: out.regularHours,
    overtimeHours: out.overtimeHours,
    doubleTimeHours: out.doubleTimeHours,
    overtimeMultiplier: out.overtimeMultiplier,
    doubleMultiplier: out.doubleMultiplier,
    penalties: out.penalties.filter((p) => p.payable && (p.hours > 0 || (p.cents ?? 0) > 0)).map((p) => ({ ...p, label: penaltyLabel(p) })),
    reasons: out.weeks.flatMap((w) => w.reasons),
  };
}

/* ----- The "what changes" report --------------------------------------------- */

export interface ChangeReportPerson {
  associateId: string;
  name: string;
  hourlyRate: number;
  paid: number;
  live: number;
  difference: number;
  premiumHours: number;
  premiumAmount: number;
  reasons: string[];
}

export interface ChangeReport {
  jurisdiction: string;
  siteId: string | null;
  runs: Array<{ id: string; periodStart: string; periodEnd: string }>;
  people: number;
  /** Live pay minus what was paid, premiums included. */
  amountDifference: number;
  premiumAmount: number;
  byRule: Record<'OVERTIME' | 'MEAL' | 'REST' | 'REST_BETWEEN_SHIFTS', number>;
  rows: ChangeReportPerson[];
  signables: Array<{ id: string; label: string; source: string; status: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The last finalized runs replayed for one jurisdiction (or site): who would
 * have been paid more or less had these rules been live, by how much, and
 * under which rule. Reads only.
 */
export async function buildChangeReport(db: Db, tenantId: string, input: { jurisdiction: string; siteId?: string | null; runs?: number }): Promise<ChangeReport> {
  const pool = await loadRulePool(db, tenantId);
  const stateCode = input.jurisdiction.replace(/^US-/, '');
  const sites = await db.site.findMany({
    where: { tenantId, deletedAt: null, ...(input.siteId ? { id: input.siteId } : { state: stateCode }) },
    select: { id: true, state: true, city: true, timezone: true },
  });
  const signables = signablesFor(pool, input.jurisdiction, sites.map((s) => s.id));
  const pinned = signedPool(pool, signables.map((s) => s.id));
  const siteIds = new Set(sites.map((s) => s.id));
  const runs = await db.payrollRun.findMany({
    where: { tenantId, status: { in: ['FINALIZED', 'DISBURSED'] }, kind: 'REGULAR' },
    orderBy: { periodEnd: 'desc' },
    take: Math.min(Math.max(input.runs ?? 4, 1), 12),
    select: { id: true, periodStart: true, periodEnd: true },
  });
  const byRule = { OVERTIME: 0, MEAL: 0, REST: 0, REST_BETWEEN_SHIFTS: 0 };
  const people = new Map<string, ChangeReportPerson>();
  for (const run of runs) {
    const items = await db.payrollItem.findMany({ where: { payrollRunId: run.id }, select: { associateId: true, hourlyRate: true, associate: { select: { firstName: true, lastName: true } } } });
    if (!items.length || !siteIds.size) continue;
    const entries = await db.timeEntry.findMany({
      where: { status: 'APPROVED', associateId: { in: items.map((i) => i.associateId) }, locationId: { in: [...siteIds] }, clockInAt: { gte: run.periodStart, lt: new Date(run.periodEnd.getTime() + 86_400_000) }, clockOutAt: { not: null } },
      select: { id: true, associateId: true, clockInAt: true, clockOutAt: true, locationId: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
    });
    const siteById = new Map(sites.map((s) => [s.id, s]));
    for (const item of items) {
      const mine = entries.filter((e) => e.associateId === item.associateId);
      if (!mine.length) continue;
      const rate = Number(item.hourlyRate);
      const paid = splitWeeklyOvertime(mine.map((e) => ({ status: 'APPROVED', clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, location: (() => { const tz = siteById.get(e.locationId!)?.timezone; return tz ? { timezone: tz } : null; })() })));
      const work: WorkEntry[] = mine.map((e) => ({ id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt!, breaks: e.breaks, timezone: siteById.get(e.locationId!)?.timezone ?? companyWorkweek().timezone }));
      const siteFor = new Map(work.map((w, i) => [w, siteById.get(mine[i]!.locationId!)!]));
      const out = evaluateTime(work, { rulesFor: (w, date) => rulesForSite(pinned, siteFor.get(w)!, date), weekStart: (d, tz) => startOfWeekForSite(d, tz) });
      const paidAmount = paid.regularHours * rate + paid.overtimeHours * rate * 1.5;
      const hoursAmount = out.regularHours * rate + out.overtimeHours * rate * out.overtimeMultiplier + out.doubleTimeHours * rate * out.doubleMultiplier;
      const prem = out.penalties.filter((p) => p.hours > 0 || (p.cents ?? 0) > 0);
      let premiumAmount = 0;
      for (const p of prem) {
        const amt = p.hours * rate + (p.cents ?? 0) / 100;
        premiumAmount += amt;
        byRule[p.kind] += amt;
      }
      byRule.OVERTIME += hoursAmount - paidAmount;
      const live = hoursAmount + premiumAmount;
      if (Math.abs(live - paidAmount) < 0.005) continue;
      const row = people.get(item.associateId) ?? {
        associateId: item.associateId,
        name: `${item.associate.firstName} ${item.associate.lastName}`.trim(),
        hourlyRate: rate,
        paid: 0,
        live: 0,
        difference: 0,
        premiumHours: 0,
        premiumAmount: 0,
        reasons: [] as string[],
      };
      row.paid = round2(row.paid + paidAmount);
      row.live = round2(row.live + live);
      row.difference = round2(row.live - row.paid);
      row.premiumHours = round2(row.premiumHours + prem.reduce((a, p) => a + p.hours, 0));
      row.premiumAmount = round2(row.premiumAmount + premiumAmount);
      row.reasons = [...row.reasons, ...out.weeks.flatMap((w) => w.reasons), ...prem.map((p) => p.reason)].slice(0, 8);
      people.set(item.associateId, row);
    }
  }
  const rows = [...people.values()].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return {
    jurisdiction: input.jurisdiction,
    siteId: input.siteId ?? null,
    runs: runs.map((r) => ({ id: r.id, periodStart: r.periodStart.toISOString().slice(0, 10), periodEnd: r.periodEnd.toISOString().slice(0, 10) })),
    people: rows.length,
    amountDifference: round2(rows.reduce((a, r) => a + r.difference, 0)),
    premiumAmount: round2(rows.reduce((a, r) => a + r.premiumAmount, 0)),
    byRule: { OVERTIME: round2(byRule.OVERTIME), MEAL: round2(byRule.MEAL), REST: round2(byRule.REST), REST_BETWEEN_SHIFTS: round2(byRule.REST_BETWEEN_SHIFTS) },
    rows,
    signables: signables.map((s) => ({ id: s.id, label: setLabelForPeople(s), source: s.source, status: s.status })),
  };
}

/* ----- Going live, and back ------------------------------------------------- */

export interface GoLiveInput {
  jurisdiction: string;
  siteId?: string | null;
  counselName: string;
  counselFirm: string;
  counselSignedOn: string;
  attestation: string;
}

const audit = (actorUserId: string, action: string, id: string, metadata: Record<string, unknown>) =>
  enqueueAudit({ actorUserId, clientId: null, action, entityType: 'LaborRuleActivation', entityId: id, metadata: metadata as never }, 'laborRules.live');

/** The activation in force (LIVE), or waiting on a second person (PENDING), for a scope. */
export async function currentActivation(db: Db, tenantId: string, jurisdiction: string, siteId: string | null) {
  return db.laborRuleActivation.findFirst({ where: { tenantId, jurisdiction, siteId, status: { in: ['LIVE', 'PENDING'] } }, orderBy: { createdAt: 'desc' } });
}

export async function requestGoLive(db: Db, input: GoLiveInput, actorUserId: string): Promise<{ activation: LaborRuleActivation; pending: boolean; approvalId: string | null }> {
  const tenantId = tenantIdForWrite();
  if (!LIVE_JURISDICTIONS.includes(input.jurisdiction)) throw new HttpError(400, 'unknown_jurisdiction', 'No rule pack covers that jurisdiction yet.');
  const signedOn = new Date(`${input.counselSignedOn}T00:00:00Z`);
  if (Number.isNaN(signedOn.getTime()) || signedOn.getTime() > Date.now() + 86_400_000) throw new HttpError(400, 'bad_signoff_date', 'Counsel’s sign-off date must be today or earlier.');
  if (input.attestation.trim() !== ATTESTATION_TEXT) throw new HttpError(400, 'attestation_required', 'Confirm the attestation exactly as shown.');
  if (input.siteId) {
    const site = await db.site.findFirst({ where: { id: input.siteId, tenantId, deletedAt: null }, select: { id: true, state: true } });
    if (!site) throw new HttpError(404, 'site_not_found', 'Site not found.');
    if (`US-${(site.state ?? '').toUpperCase()}` !== input.jurisdiction) throw new HttpError(400, 'site_outside_jurisdiction', 'That site is not in this state.');
  }
  if (await currentActivation(db, tenantId, input.jurisdiction, input.siteId ?? null)) {
    throw new HttpError(409, 'already_live_or_pending', 'This is already live, or waiting on a second person.');
  }
  const report = await buildChangeReport(db, tenantId, { jurisdiction: input.jurisdiction, siteId: input.siteId ?? null });
  if (report.signables.length === 0) throw new HttpError(409, 'nothing_to_sign', 'No rule sets are in force for this jurisdiction.');
  const summary = { people: report.people, amountDifference: report.amountDifference, premiumAmount: report.premiumAmount, byRule: report.byRule, runs: report.runs.length };
  const activation = await db.laborRuleActivation.create({
    data: {
      tenantId,
      jurisdiction: input.jurisdiction,
      siteId: input.siteId ?? null,
      status: 'PENDING',
      signedSetIds: report.signables.map((s) => s.id),
      signedLabels: report.signables.map((s) => s.label),
      counselName: input.counselName.trim(),
      counselFirm: input.counselFirm.trim(),
      counselSignedOn: signedOn,
      attestation: input.attestation.trim(),
      changeReport: summary,
      requestedById: actorUserId,
    },
  });
  audit(actorUserId, 'labor_rules.go_live_requested', activation.id, { jurisdiction: input.jurisdiction, siteId: input.siteId ?? null, signed: report.signables.map((s) => s.label), counselName: input.counselName, counselFirm: input.counselFirm, counselSignedOn: input.counselSignedOn });

  // A second person decides. Where nobody else could, it lands now and the record says so.
  if (!(await secondPersonExists(db, 'manage:org', actorUserId, tenantId))) {
    const live = await db.laborRuleActivation.update({ where: { id: activation.id }, data: { status: 'LIVE', activatedById: actorUserId, activatedAt: new Date() } });
    audit(actorUserId, 'labor_rules.went_live', activation.id, { jurisdiction: input.jurisdiction, siteId: input.siteId ?? null, note: 'No second approver was available.' });
    return { activation: live, pending: false, approvalId: null };
  }
  const label = jurisdictionLabel(input.jurisdiction);
  const approval = await createApprovalRequest(db, {
    kind: 'LABOR_RULES_LIVE',
    subjectType: 'LaborRuleActivation',
    subjectId: activation.id,
    title: `Pay ${input.siteId ? 'one site in ' : ''}${label} by its labor rules`,
    summary: `Counsel ${input.counselName} (${input.counselFirm}) signed on ${input.counselSignedOn}. Over the last ${report.runs.length} runs, ${report.people} people would have been paid ${report.amountDifference >= 0 ? 'more' : 'less'} by $${Math.abs(report.amountDifference).toFixed(2)}.`,
    proposed: { jurisdiction: input.jurisdiction, jurisdictionLabel: label, siteId: input.siteId ?? null, counselName: input.counselName, counselFirm: input.counselFirm, counselSignedOn: input.counselSignedOn, signed: report.signables.map((s) => s.label), changeReport: summary },
    before: { mode: 'shadow' },
    requesterUserId: actorUserId,
    approver: { capability: 'manage:org' },
  });
  const pending = await db.laborRuleActivation.update({ where: { id: activation.id }, data: { approvalRequestId: approval.id } });
  return { activation: pending, pending: true, approvalId: approval.id };
}

/** Back to shadow: instant, audited, never needs a second person (it only stops the engine paying). */
export async function endLive(db: Db, id: string, actorUserId: string, reason: string): Promise<LaborRuleActivation> {
  const tenantId = tenantIdForWrite();
  const row = await db.laborRuleActivation.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'activation_not_found', 'Not found.');
  if (row.status !== 'LIVE' && row.status !== 'PENDING') throw new HttpError(409, 'not_live', 'This is not live.');
  const ended = await db.laborRuleActivation.update({ where: { id }, data: { status: 'ENDED', endedById: actorUserId, endedAt: new Date(), endReason: reason } });
  if (row.approvalRequestId && row.status === 'PENDING') {
    await db.approvalRequest.updateMany({ where: { id: row.approvalRequestId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  }
  audit(actorUserId, 'labor_rules.back_to_shadow', id, { jurisdiction: row.jurisdiction, siteId: row.siteId, previous: row.status, reason });
  return ended;
}

registerApplyHandler(
  'LABOR_RULES_LIVE',
  async (db, req, decider) => {
    const row = await db.laborRuleActivation.findFirst({ where: { id: req.subjectId } });
    if (!row || row.status !== 'PENDING') throw new Error('This go-live is no longer waiting.');
    await db.laborRuleActivation.update({ where: { id: row.id }, data: { status: 'LIVE', activatedById: decider.id, activatedAt: new Date() } });
    audit(decider.id, 'labor_rules.went_live', row.id, { jurisdiction: row.jurisdiction, siteId: row.siteId, approvalRequestId: req.id });
  },
  async (db, req, decider) => {
    await db.laborRuleActivation.updateMany({ where: { id: req.subjectId, status: 'PENDING' }, data: { status: 'REJECTED', endedById: decider.id, endedAt: new Date(), endReason: req.reason ?? null } });
  },
);

export { jurisdictionsFor };
