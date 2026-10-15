import type { Prisma, PrismaClient } from '@prisma/client';
import { capabilityDef } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { placements } from './activeDefinition.js';
import { logAgentAction } from './agents.js';
import { registerCapabilityMetrics, registerCapabilityRunner } from './agentCapabilities.js';
import { complianceAgentFor } from './complianceAgent.js';
import { notifyAssociate } from './notify.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';
import { toWaLang, type WaLang } from './whatsappContent.js';

/**
 * The Compliance agent's `coverage.credentials` (agent families step 5;
 * docs/agent-families-investigation.md §4).
 *
 *   A site (or every site of a client) may require a credential: a
 *   vaccination kind, a training by compliance tag, or a qualification
 *   (CredentialRequirement; nothing is required until someone sets it).
 *   Once a week the agent measures each requirement: the people placed in
 *   scope (lib/activeDefinition placements) against those holding it
 *   current (not expired), writes the week (CredentialCoverageWeek), puts
 *   the gaps on the compliance desk, and asks each person missing it, once
 *   that week, in their language, where to provide it. Read and notice
 *   only: no gate.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const COVERAGE_CREDENTIALS = 'coverage.credentials';
const ASK_CATEGORY = 'compliance.credentials';

export type RequirementKind = 'VACCINATION' | 'TRAINING' | 'QUALIFICATION';

export interface RequirementRow {
  id: string;
  locationId: string | null;
  clientId: string | null;
  kind: string;
  vaccinationKind: string | null;
  complianceTag: string | null;
  qualificationId: string | null;
  label: string;
}

/** Who is placed in the requirement's scope, and which of them hold it current. */
export async function coverageOf(db: Db, tenantId: string, req: RequirementRow, now: Date): Promise<{ population: string[]; missing: string[] }> {
  const placed = await placements(req.locationId ? { locationId: req.locationId, tenantId } : { clientId: req.clientId, tenantId }, db as PrismaClient);
  const population = [...placed.keys()];
  if (!population.length) return { population, missing: [] };
  const current = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  let holders: string[] = [];
  if (req.kind === 'VACCINATION' && req.vaccinationKind) {
    const rows = await db.vaccinationRecord.findMany({
      where: { associateId: { in: population }, kind: req.vaccinationKind as Prisma.EnumVaccinationKindFilter['equals'], OR: [{ expiresOn: null }, { expiresOn: { gt: now } }] },
      select: { associateId: true },
    });
    holders = rows.map((r) => r.associateId);
  } else if (req.kind === 'TRAINING' && req.complianceTag) {
    const rows = await db.courseEnrollment.findMany({
      where: { associateId: { in: population }, status: 'COMPLETED', course: { complianceTag: req.complianceTag as Prisma.EnumComplianceTagNullableFilter['equals'], deletedAt: null }, ...current },
      select: { associateId: true },
    });
    holders = rows.map((r) => r.associateId);
  } else if (req.kind === 'QUALIFICATION' && req.qualificationId) {
    const rows = await db.associateQualification.findMany({
      where: { associateId: { in: population }, qualificationId: req.qualificationId, deletedAt: null, ...current },
      select: { associateId: true },
    });
    holders = rows.map((r) => r.associateId);
  }
  const held = new Set(holders);
  return { population, missing: population.filter((id) => !held.has(id)) };
}

/** The ask, in the person's language: what the place requires and where to provide it. */
export function credentialAsk(lang: WaLang, label: string, place: string, kind: string): { subject: string; body: string; linkUrl: string } {
  const training = kind === 'TRAINING';
  const linkUrl = training ? '/learning' : '/documents';
  if (lang === 'es') {
    return {
      subject: `${place} requiere: ${label}`,
      body: training ? `${place} requiere ${label}. Complétalo en la app, en Aprendizaje.` : `${place} requiere ${label}. Sube tu comprobante en la app, en Documentos.`,
      linkUrl,
    };
  }
  if (lang === 'tr') {
    return {
      subject: `${place} için gerekli: ${label}`,
      body: training ? `${place} için ${label} gerekli. Uygulamada Eğitim bölümünden tamamla.` : `${place} için ${label} gerekli. Belgeni uygulamada Belgeler bölümüne yükle.`,
      linkUrl,
    };
  }
  return {
    subject: `${place} requires: ${label}`,
    body: training ? `${place} requires ${label}. Complete it in the app under Learning.` : `${place} requires ${label}. Upload your proof in the app under Documents.`,
    linkUrl,
  };
}

const REQUIREMENT_SELECT = {
  id: true,
  locationId: true,
  clientId: true,
  kind: true,
  vaccinationKind: true,
  complianceTag: true,
  qualificationId: true,
  label: true,
  location: { select: { name: true } },
  client: { select: { name: true } },
} as const;

export const requirementPlace = (r: { location: { name: string } | null; client: { name: string } | null }) => r.location?.name ?? r.client?.name ?? 'This site';

export interface CredentialCoverageRun {
  measured: number;
  gaps: number;
  asked: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** Once a week per requirement (the week's row is the claim): measure, record, ask the missing. */
export async function runCredentialCoverage(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<CredentialCoverageRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: CredentialCoverageRun = { measured: 0, gaps: 0, asked: 0 };
  const agent = await complianceAgentFor(db, tenantId, COVERAGE_CREDENTIALS);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  const weekOf = new Date(`${orgDateKey(startOfWeekUTC(now))}T00:00:00Z`);
  const reqs = await db.credentialRequirement.findMany({ where: { tenantId, deletedAt: null, weeks: { none: { weekOf } } }, select: REQUIREMENT_SELECT });
  for (const r of reqs) {
    const { population, missing } = await coverageOf(db, tenantId, r, now);
    try {
      await db.credentialCoverageWeek.create({ data: { tenantId, requirementId: r.id, weekOf, population: population.length, missing: missing.length, missingIds: missing } });
    } catch {
      continue; // another tick wrote this week first
    }
    out.measured += 1;
    if (missing.length) out.gaps += 1;
    const place = requirementPlace(r);
    for (const associateId of missing) {
      const user = await db.user.findFirst({ where: { associateId, status: 'ACTIVE' }, select: { language: true } });
      const ask = credentialAsk(toWaLang(user?.language), r.label, place, r.kind);
      await notifyAssociate(associateId, { subject: ask.subject, body: ask.body, category: ASK_CATEGORY, linkUrl: ask.linkUrl, emailFallback: true });
      out.asked += 1;
    }
    logAgentAction(agent, { action: 'agent.credentials.measured', entityType: 'CredentialRequirement', entityId: r.id, scopes: [...capabilityDef(COVERAGE_CREDENTIALS)!.scopes], metadata: { weekOf: weekOf.toISOString().slice(0, 10), population: population.length, missing: missing.length } });
  }
  return out;
}

/** The desk's read: each live requirement's latest week, with what it found. */
export async function latestCoverage(db: Db, tenantId: string) {
  const reqs = await db.credentialRequirement.findMany({
    where: { tenantId, deletedAt: null },
    select: { ...REQUIREMENT_SELECT, weeks: { orderBy: { weekOf: 'desc' }, take: 1, select: { weekOf: true, population: true, missing: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return reqs.map((r) => ({ ...r, place: requirementPlace(r), latest: r.weeks[0] ?? null }));
}

/* ---- Registration: certification and the scorecard -------------------- */

let registered = false;

export function registerCredentialCoverage(): void {
  if (registered) return;
  registered = true;
  // The fixture's requirements, measured by the real read.
  registerCapabilityRunner(COVERAGE_CREDENTIALS, async (ctx) => {
    const reqs = await ctx.db.credentialRequirement.findMany({ where: { tenantId: ctx.tenantId, deletedAt: null }, select: REQUIREMENT_SELECT });
    const missing: string[] = [];
    const covered: string[] = [];
    for (const r of reqs) {
      const c = await coverageOf(ctx.db, ctx.tenantId, r, ctx.now);
      missing.push(...c.missing);
      covered.push(...c.population.filter((id) => !c.missing.includes(id)));
    }
    covered.sort();
    return { output: { coveredRef: covered[0] ?? null, missing: missing.length }, actions: [] };
  });
  registerCapabilityMetrics(COVERAGE_CREDENTIALS, async (db, workerId, since) => {
    const worker = await db.worker.findUnique({ where: { id: workerId }, select: { tenantId: true } });
    const tenantId = worker?.tenantId ?? ALTO_TENANT_ID;
    const weeks = await db.credentialCoverageWeek.findMany({ where: { tenantId, requirement: { deletedAt: null } }, orderBy: { weekOf: 'asc' }, select: { requirementId: true, weekOf: true, missingIds: true, missing: true } });
    const byReq = new Map<string, typeof weeks>();
    for (const w of weeks) (byReq.get(w.requirementId) ?? byReq.set(w.requirementId, []).get(w.requirementId)!).push(w);
    let below = 0;
    let closed = 0;
    for (const list of byReq.values()) {
      const last = list[list.length - 1]!;
      if (last.missing > 0) below += 1;
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.weekOf < since) continue;
        const now = new Set(list[i]!.missingIds as string[]);
        closed += (list[i - 1]!.missingIds as string[]).filter((id) => !now.has(id)).length;
      }
    }
    return { sitesBelowRequirement: below, gapsClosed: closed };
  });
}

registerCredentialCoverage();
