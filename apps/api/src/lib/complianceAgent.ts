import type { Prisma, PrismaClient } from '@prisma/client';
import { capabilityDef, rolesWithCapability } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { inProcessAgent, logAgentAction, type AgentContext } from './agents.js';
import { registerCapabilityMetrics, registerCapabilityRunner } from './agentCapabilities.js';
import { addBusinessDays, evaluateEVerifyReadiness, EVERIFY_DUE_BUSINESS_DAYS } from './everifyReadiness.js';
import { notifyAssociate, notifyUser } from './notify.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { moduleOn } from './tenantProfile.js';
import { orgDateKey } from './timeAnomalies.js';
import { toWaLang, type WaLang } from './whatsappContent.js';

/**
 * The Compliance agent (agent families step 4;
 * docs/agent-families-investigation.md §4).
 *
 *   document.chase — for each document or authorization a person can renew
 *   (an identity or work document, the I-9 work authorization, a
 *   vaccination) that expires within 30 days: the person hears in their
 *   language with the link to upload, again at 14 and at 3 days, one message
 *   a person a day; at expiry it goes to HR as a decision item. It stops the
 *   moment a newer one is on file, the item is waived or snoozed on the
 *   compliance scorecard (the same action key the scorecard reads), or the
 *   person no longer works here. Results HR uploads (background, drug test,
 *   E-Verify, paystubs, agreements) are never chased.
 *
 *   i9.section2 — for each approved hire still without Section 2: the
 *   deadline, three business days from the start date (the same weekend-only
 *   count as the scorecard and the E-Verify queue, so no screen disagrees),
 *   on the verifier desk as a dated item with the E-Verify readiness reason;
 *   the day before it is due, and again if it is missed, the HR desk hears
 *   it once. A person completes Section 2; the agent never does.
 *
 *   Both are notices and desk items, no gate (owner's decision 3); every
 *   chase and every climb is on the agent's trail.
 */

type Db = PrismaClient;

export const COMPLIANCE_AGENT_KEY = 'compliance-agent' as const;
export const DOCUMENT_CHASE = 'document.chase';
export const I9_SECTION2 = 'i9.section2';
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** Expired items stay on HR's desk this long before they fall out of the sweep. */
const EXPIRED_LOOKBACK_DAYS = 90;
const ONE_PER_DAY_MS = 20 * 3_600_000;
const CHASE_CATEGORY = 'documents.chase';
const I9_CATEGORY = 'compliance.i9';
/** Document kinds a person renews themselves. */
const CHASED_DOC_KINDS = ['ID', 'SSN_CARD', 'I9_SUPPORTING', 'J1_DS2019', 'J1_VISA', 'OTHER'] as const;

type ChaseKind = 'DOCUMENT' | 'I9_WORK_AUTH' | 'VACCINATION';

/** The words for each item, in the person's language. */
const DOC_WORDS: Record<string, Record<WaLang, string>> = {
  ID: { en: 'ID', es: 'identificación', tr: 'kimlik' },
  SSN_CARD: { en: 'Social Security card', es: 'tarjeta de Seguro Social', tr: 'Sosyal Güvenlik kartı' },
  I9_SUPPORTING: { en: 'work authorization document', es: 'documento de autorización de trabajo', tr: 'çalışma izni belgesi' },
  J1_DS2019: { en: 'DS-2019 form', es: 'formulario DS-2019', tr: 'DS-2019 formu' },
  J1_VISA: { en: 'J-1 visa', es: 'visa J-1', tr: 'J-1 vizesi' },
  OTHER: { en: 'document', es: 'documento', tr: 'belge' },
  I9_WORK_AUTH: { en: 'work authorization', es: 'autorización de trabajo', tr: 'çalışma izni' },
  VACCINATION: { en: 'vaccination record', es: 'registro de vacunación', tr: 'aşı kaydı' },
};

export interface ChaseItem {
  itemKey: string;
  associateId: string;
  associateName: string;
  kind: ChaseKind;
  /** DOC_WORDS key. */
  wordKey: string;
  /** English label for HR (the scorecard's wording). */
  label: string;
  expiresAt: Date;
}

/** The scorecard's action key: a waiver or snooze set there is read here (complianceScorecard.ts). */
export const chaseKey = (kind: ChaseKind, associateId: string, expiresAt: Date) => `exp:${kind}:${associateId}:${expiresAt.toISOString()}`;

const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * Everything to chase now: expiring within 30 days or expired in the last
 * 90, held by someone employed, not superseded by a newer one of the same
 * kind, not waived (DONE) or snoozed on the scorecard.
 */
export async function chaseItems(db: Db, tenantId: string, now: Date): Promise<ChaseItem[]> {
  const from = new Date(now.getTime() - EXPIRED_LOOKBACK_DAYS * DAY_MS);
  const to = new Date(now.getTime() + WINDOW_DAYS * DAY_MS);
  const employed = { tenantId, ...EMPLOYED_WHERE } satisfies Prisma.AssociateWhereInput;
  const name = (a: { firstName: string; lastName: string }) => `${a.firstName} ${a.lastName}`.trim();
  const items: ChaseItem[] = [];

  const docs = await db.documentRecord.findMany({
    where: { tenantId, deletedAt: null, status: { not: 'REJECTED' }, kind: { in: [...CHASED_DOC_KINDS] }, expiresAt: { gte: from, lte: to }, associate: employed },
    select: { associateId: true, kind: true, filename: true, expiresAt: true, createdAt: true, associate: { select: { firstName: true, lastName: true } } },
    take: 2_000,
  });
  if (docs.length) {
    // A newer one of the same kind on file (not rejected) covers the old.
    const newer = await db.documentRecord.findMany({
      where: { tenantId, deletedAt: null, status: { not: 'REJECTED' }, associateId: { in: [...new Set(docs.map((d) => d.associateId!))] }, kind: { in: [...CHASED_DOC_KINDS] } },
      select: { associateId: true, kind: true, createdAt: true },
    });
    for (const d of docs) {
      if (!d.associateId || !d.expiresAt) continue;
      if (newer.some((n) => n.associateId === d.associateId && n.kind === d.kind && n.createdAt > d.createdAt)) continue;
      items.push({ itemKey: chaseKey('DOCUMENT', d.associateId, d.expiresAt), associateId: d.associateId, associateName: name(d.associate!), kind: 'DOCUMENT', wordKey: d.kind, label: `${humanize(d.kind)} — ${d.filename}`, expiresAt: d.expiresAt });
    }
  }

  const i9 = await db.i9Verification.findMany({
    where: { tenantId, workAuthExpiresAt: { gte: from, lte: to }, associate: employed },
    select: { associateId: true, workAuthExpiresAt: true, associate: { select: { firstName: true, lastName: true } } },
    take: 2_000,
  });
  for (const r of i9) {
    items.push({ itemKey: chaseKey('I9_WORK_AUTH', r.associateId, r.workAuthExpiresAt!), associateId: r.associateId, associateName: name(r.associate), kind: 'I9_WORK_AUTH', wordKey: 'I9_WORK_AUTH', label: 'I-9 work authorization', expiresAt: r.workAuthExpiresAt! });
  }

  const vax = await db.vaccinationRecord.findMany({
    where: { tenantId, expiresOn: { gte: from, lte: to }, associate: employed },
    select: { associateId: true, kind: true, customLabel: true, expiresOn: true, administeredOn: true, associate: { select: { firstName: true, lastName: true } } },
    take: 2_000,
  });
  if (vax.length) {
    const later = await db.vaccinationRecord.findMany({
      where: { tenantId, associateId: { in: [...new Set(vax.map((v) => v.associateId))] } },
      select: { associateId: true, kind: true, administeredOn: true },
    });
    for (const v of vax) {
      if (later.some((l) => l.associateId === v.associateId && l.kind === v.kind && l.administeredOn > v.administeredOn)) continue;
      const label = v.kind === 'OTHER' && v.customLabel ? `Vaccination — ${v.customLabel}` : `Vaccination — ${humanize(v.kind)}`;
      items.push({ itemKey: chaseKey('VACCINATION', v.associateId, v.expiresOn!), associateId: v.associateId, associateName: name(v.associate), kind: 'VACCINATION', wordKey: 'VACCINATION', label, expiresAt: v.expiresOn! });
    }
  }

  if (!items.length) return items;
  const states = await db.complianceActionState.findMany({ where: { actionKey: { in: items.map((i) => i.itemKey) } }, select: { actionKey: true, status: true, snoozedUntil: true } });
  const off = new Set(states.filter((s) => s.status === 'DONE' || (s.status === 'SNOOZED' && (!s.snoozedUntil || s.snoozedUntil > now))).map((s) => s.actionKey));
  return items.filter((i) => !off.has(i.itemKey));
}

/** 1 at 30 days out, 2 at 14, 3 at 3; 0 when not yet due; -1 once expired. */
export function chaseStage(expiresAt: Date, now: Date): number {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return -1;
  if (days <= 3) return 3;
  if (days <= 14) return 2;
  if (days <= WINDOW_DAYS) return 1;
  return 0;
}

const dayIn = (d: Date, lang: WaLang) =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(d);

/** The chase, in the person's language: one message for every item due today. */
export function chaseMessage(lang: WaLang, items: Array<{ wordKey: string; expiresAt: Date }>): { subject: string; body: string } {
  const word = (i: { wordKey: string }) => (DOC_WORDS[i.wordKey] ?? DOC_WORDS.OTHER!)[lang];
  const lines = items.map((i) => `• ${word(i)}: ${dayIn(i.expiresAt, lang)}`).join('\n');
  if (lang === 'es') {
    return {
      subject: items.length === 1 ? `Renueva tu ${word(items[0]!)}` : `${items.length} documentos por renovar`,
      body: `Estos vencen pronto:\n${lines}\nSube el nuevo en la app, en Documentos, para seguir trabajando sin interrupciones.`,
    };
  }
  if (lang === 'tr') {
    return {
      subject: items.length === 1 ? `${word(items[0]!)} yenilenmeli` : `Yenilenmesi gereken ${items.length} belge`,
      body: `Bunların süresi yakında doluyor:\n${lines}\nKesintisiz çalışmaya devam etmek için yenisini uygulamada Belgeler bölümüne yükle.`,
    };
  }
  return {
    subject: items.length === 1 ? `Please renew your ${word(items[0]!)}` : `${items.length} documents to renew`,
    body: `These expire soon:\n${lines}\nUpload the new one in the app under Documents so you can keep working without a gap.`,
  };
}

/** Is a capability of this agent running for the tenant (module, agent, capability)? The agent, or why not. */
async function complianceAgentFor(db: Db, tenantId: string, key: string): Promise<AgentContext | 'module_off' | 'agent_stopped' | 'capability_off'> {
  for (const m of capabilityDef(key)!.requiresModule) {
    if (!(await moduleOn(m, tenantId))) return 'module_off';
  }
  const agent = await inProcessAgent(db, COMPLIANCE_AGENT_KEY, tenantId);
  if (!agent) return 'agent_stopped';
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return 'capability_off';
  return agent;
}

export interface DocumentChaseRun {
  chased: number;
  messages: number;
  escalated: number;
  resolved: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** One tick for the tenant in context: close what was renewed or waived, chase, escalate. */
export async function runDocumentChase(db: Db = defaultPrisma, now: Date = new Date()): Promise<DocumentChaseRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: DocumentChaseRun = { chased: 0, messages: 0, escalated: 0, resolved: 0 };
  const agent = await complianceAgentFor(db, tenantId, DOCUMENT_CHASE);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  const scopes = [...capabilityDef(DOCUMENT_CHASE)!.scopes];

  const items = await chaseItems(db, tenantId, now);
  const byKey = new Map(items.map((i) => [i.itemKey, i]));

  // 1. Chases no longer in the set: renewed, waived or the person left.
  const open = await db.documentChase.findMany({ where: { tenantId, resolvedAt: null } });
  for (const c of open) {
    if (byKey.has(c.itemKey)) continue;
    const state = await db.complianceActionState.findUnique({ where: { actionKey: c.itemKey }, select: { status: true } });
    const person = await db.associate.findUnique({ where: { id: c.associateId }, select: { deletedAt: true, erasedAt: true, separatedAt: true, deactivatedAt: true } });
    const resolution = state && state.status !== 'OPEN' ? 'WAIVED' : !person || person.deletedAt || person.erasedAt || person.separatedAt || person.deactivatedAt ? 'LEFT' : 'RENEWED';
    await db.documentChase.update({ where: { id: c.id }, data: { resolvedAt: now, resolution } });
    logAgentAction(agent, { action: 'agent.document_chase.resolved', entityType: 'Associate', entityId: c.associateId, scopes, metadata: { itemKey: c.itemKey, resolution } });
    out.resolved += 1;
  }

  // 2. Make sure every item has its row; escalate the expired.
  const rows = new Map((await db.documentChase.findMany({ where: { itemKey: { in: items.map((i) => i.itemKey) } } })).map((r) => [r.itemKey, r]));
  for (const i of items) {
    if (!rows.has(i.itemKey)) {
      const row = await db.documentChase.create({ data: { tenantId, itemKey: i.itemKey, associateId: i.associateId, workerId: agent.workerId, kind: i.kind, label: i.label.slice(0, 200), expiresAt: i.expiresAt } });
      rows.set(i.itemKey, row);
    }
    const row = rows.get(i.itemKey)!;
    if (row.resolvedAt) {
      // Back in the set (a waiver lifted, say): open it again.
      await db.documentChase.update({ where: { id: row.id }, data: { resolvedAt: null, resolution: null } });
    }
    if (chaseStage(i.expiresAt, now) === -1 && !row.escalatedAt) {
      await db.documentChase.update({ where: { id: row.id }, data: { escalatedAt: now } });
      logAgentAction(agent, { action: 'agent.document_chase.escalated', entityType: 'Associate', entityId: i.associateId, scopes, metadata: { itemKey: i.itemKey, label: i.label } });
      out.escalated += 1;
    }
  }

  // 3. The person hears, once a day, about every item whose next reminder is due.
  const due = new Map<string, ChaseItem[]>();
  for (const i of items) {
    const stage = chaseStage(i.expiresAt, now);
    if (stage > rows.get(i.itemKey)!.stage) (due.get(i.associateId) ?? due.set(i.associateId, []).get(i.associateId)!).push(i);
  }
  for (const [associateId, list] of due) {
    const recent = await db.documentChase.findFirst({ where: { associateId, lastSentAt: { gt: new Date(now.getTime() - ONE_PER_DAY_MS) } }, select: { id: true } });
    if (recent) continue;
    const user = await db.user.findFirst({ where: { associateId, status: 'ACTIVE' }, select: { language: true } });
    const lang = toWaLang(user?.language);
    const msg = chaseMessage(lang, list);
    await notifyAssociate(associateId, { subject: msg.subject, body: msg.body, category: CHASE_CATEGORY, linkUrl: '/documents', emailFallback: true });
    for (const i of list) {
      await db.documentChase.update({ where: { itemKey: i.itemKey }, data: { stage: chaseStage(i.expiresAt, now), lastSentAt: now } });
    }
    logAgentAction(agent, { action: 'agent.document_chase.sent', entityType: 'Associate', entityId: associateId, scopes, metadata: { items: list.map((i) => i.itemKey), lang } });
    out.messages += 1;
    out.chased += list.length;
  }
  return out;
}

/* ---------------------------------------------------------- i9.section2 */

export interface Section2Hire {
  associateId: string;
  name: string;
  applicationId: string | null;
  startDate: Date | null;
  /** Three business days from the start (weekends skipped, as the scorecard and E-Verify count). */
  dueBy: Date | null;
  /** The E-Verify readiness blockers besides Section 2 itself. */
  blockers: string[];
}

/** Every approved hire, still employed, whose Section 2 is not done; earliest deadline first. */
export async function pendingSection2(db: Db, tenantId: string): Promise<Section2Hire[]> {
  const people = await db.associate.findMany({
    where: {
      tenantId,
      ...EMPLOYED_WHERE,
      applications: { some: { status: 'APPROVED', deletedAt: null } },
      OR: [{ i9Verification: null }, { i9Verification: { section2CompletedAt: null } }],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      dob: true,
      w4Submission: { select: { ssnEncrypted: true } },
      i9Verification: { select: { section1CompletedAt: true, section2CompletedAt: true, citizenshipStatus: true } },
      applications: { where: { status: 'APPROVED', deletedAt: null }, orderBy: { invitedAt: 'desc' }, take: 1, select: { id: true, startDate: true } },
    },
    take: 1_000,
  });
  const out = people.map((p) => {
    const app = p.applications[0] ?? null;
    const startDate = p.hireDate ?? app?.startDate ?? null;
    const readiness = evaluateEVerifyReadiness({
      hasI9: !!p.i9Verification,
      section1CompletedAt: p.i9Verification?.section1CompletedAt ?? null,
      section2CompletedAt: p.i9Verification?.section2CompletedAt ?? null,
      citizenshipStatus: p.i9Verification?.citizenshipStatus ?? null,
      hasReadableSsn: !!p.w4Submission?.ssnEncrypted,
      dob: p.dob,
      hireDate: startDate,
    });
    return {
      associateId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      applicationId: app?.id ?? null,
      startDate,
      dueBy: startDate ? addBusinessDays(startDate, EVERIFY_DUE_BUSINESS_DAYS) : null,
      blockers: readiness.blockers.filter((b) => b !== 'SECTION2_INCOMPLETE'),
    };
  });
  return out.sort((a, b) => (a.dueBy?.getTime() ?? Infinity) - (b.dueBy?.getTime() ?? Infinity) || a.name.localeCompare(b.name));
}

/** The business day before the deadline (weekends skipped, the same count as the deadline itself). */
function dayBefore(due: Date): Date {
  const d = new Date(due);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d;
}

export interface Section2Run {
  pending: number;
  dueTomorrow: number;
  late: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/**
 * The HR desk hears a hire's Section 2 once on the business day before it
 * is due and once when it is missed (the trail is the claim). The worklist
 * itself is the verifier desk's decision items (lib/roleDecisions).
 */
export async function runSection2Clock(db: Db = defaultPrisma, now: Date = new Date()): Promise<Section2Run> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: Section2Run = { pending: 0, dueTomorrow: 0, late: 0 };
  const agent = await complianceAgentFor(db, tenantId, I9_SECTION2);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  const hires = await pendingSection2(db, tenantId);
  out.pending = hires.length;
  const today = orgDateKey(now);
  const hr = await db.user.findMany({ where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:onboarding') } }, select: { id: true } });
  for (const h of hires) {
    if (!h.dueBy) continue;
    const dueKey = h.dueBy.toISOString().slice(0, 10);
    const stage = today > dueKey ? 'late' : today >= dayBefore(h.dueBy).toISOString().slice(0, 10) ? 'due_tomorrow' : null;
    if (!stage) continue;
    const action = `agent.i9.${stage}`;
    if (await db.auditLog.findFirst({ where: { workerId: agent.workerId, action, entityId: h.associateId }, select: { id: true } })) continue;
    logAgentAction(agent, { action, entityType: 'Associate', entityId: h.associateId, scopes: [...capabilityDef(I9_SECTION2)!.scopes], metadata: { dueBy: dueKey, blockers: h.blockers } });
    const ready = h.blockers.length ? `E-Verify cannot open yet: ${h.blockers.map(blockerWords).join(', ')}.` : 'E-Verify can open once Section 2 is done.';
    for (const u of hr) {
      await notifyUser(u.id, {
        subject: stage === 'late' ? `I-9 Section 2 is late: ${h.name}` : `I-9 Section 2 due ${dueKey}: ${h.name}`,
        body: `${stage === 'late' ? `Section 2 was due ${dueKey} (three business days from the start date).` : `Section 2 is due ${dueKey}, three business days from the start date.`} ${ready}`,
        category: I9_CATEGORY,
        linkUrl: section2Link(h),
      });
    }
    if (stage === 'late') out.late += 1;
    else out.dueTomorrow += 1;
  }
  return out;
}

export const section2Link = (h: { associateId: string; applicationId: string | null }) =>
  h.applicationId ? `/onboarding/applications/${h.applicationId}` : `/compliance?tab=i9&associateId=${h.associateId}`;

const BLOCKER_WORDS: Record<string, string> = {
  NO_I9: 'no I-9 started',
  SECTION1_INCOMPLETE: 'Section 1 not done',
  NO_CITIZENSHIP: 'no citizenship status',
  NO_SSN: 'no SSN on file',
  NO_DOB: 'no date of birth',
  NO_HIRE_DATE: 'no start date',
};
export const blockerWords = (b: string) => BLOCKER_WORDS[b] ?? b.toLowerCase().replace(/_/g, ' ');

/** One tick of both (the hourly compliance cron). */
export async function runComplianceAgent(db: Db = defaultPrisma, now: Date = new Date()) {
  return { chase: await runDocumentChase(db, now), section2: await runSection2Clock(db, now) };
}

/* ---- Registration: certification and the scorecard -------------------- */

let registered = false;

export function registerComplianceAgent(): void {
  if (registered) return;
  registered = true;
  registerCapabilityRunner(DOCUMENT_CHASE, async (ctx) => {
    const items = await chaseItems(ctx.db, ctx.tenantId, ctx.now);
    const due = items.filter((i) => chaseStage(i.expiresAt, ctx.now) > 0).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    return { output: { chasedRef: due[0]?.associateId ?? null, items: due.length }, actions: due.length ? ['notify'] : [] };
  });
  registerCapabilityRunner(I9_SECTION2, async (ctx) => {
    const hires = await pendingSection2(ctx.db, ctx.tenantId);
    return { output: { firstRef: hires[0]?.associateId ?? null, pending: hires.length }, actions: [] };
  });
  registerCapabilityMetrics(DOCUMENT_CHASE, async (db, workerId, since) => {
    const rows = await db.documentChase.findMany({ where: { workerId, OR: [{ lastSentAt: { gte: since } }, { escalatedAt: { gte: since } }, { resolvedAt: { gte: since } }] }, select: { lastSentAt: true, escalatedAt: true, resolvedAt: true, resolution: true, expiresAt: true } });
    return {
      itemsChased: rows.filter((r) => r.lastSentAt && r.lastSentAt >= since).length,
      uploadedBeforeExpiry: rows.filter((r) => r.resolution === 'RENEWED' && r.resolvedAt && r.resolvedAt <= r.expiresAt).length,
      expiredAnyway: rows.filter((r) => r.escalatedAt && r.escalatedAt >= since).length,
      escalations: rows.filter((r) => r.escalatedAt && r.escalatedAt >= since && !r.resolvedAt).length,
    };
  });
  registerCapabilityMetrics(I9_SECTION2, async (db, workerId, since) => {
    const worker = await db.worker.findUnique({ where: { id: workerId }, select: { tenantId: true } });
    const tenantId = worker?.tenantId ?? ALTO_TENANT_ID;
    const hires = await db.associate.findMany({
      where: { tenantId, hireDate: { gte: since }, applications: { some: { status: 'APPROVED' } } },
      select: { hireDate: true, i9Verification: { select: { section2CompletedAt: true, eVerifyCaseOpenedAt: true } } },
      take: 5_000,
    });
    let inTime = 0;
    let late = 0;
    let everify = 0;
    const now = new Date();
    for (const h of hires) {
      const due = addBusinessDays(h.hireDate!, EVERIFY_DUE_BUSINESS_DAYS);
      const done = h.i9Verification?.section2CompletedAt ?? null;
      if (done && done <= due) inTime += 1;
      else if ((done && done > due) || (!done && now > due)) late += 1;
      if (h.i9Verification?.eVerifyCaseOpenedAt && h.i9Verification.eVerifyCaseOpenedAt <= due) everify += 1;
    }
    return { hires: hires.length, completedInTime: inTime, late, everifyOpenedInTime: everify };
  });
}

registerComplianceAgent();

/* ---- The hourly cron, per tenant --------------------------------------- */

const SWEEP_SECONDS = 60 * 60;
let timer: NodeJS.Timeout | null = null;

export function startComplianceAgentCron(): void {
  if (timer) return;
  const tick = () =>
    void tenantJob('complianceAgent', () => runComplianceAgent())().catch((err) => {
      console.error('[alto-people/api] compliance agent sweep failed:', err);
    });
  tick();
  timer = setInterval(tick, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(`[alto-people/api] compliance agent cron armed (every ${SWEEP_SECONDS}s)`);
}

export function stopComplianceAgentCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
