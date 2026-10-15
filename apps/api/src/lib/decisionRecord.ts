import type { AgentDecisionProfile, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { capabilityDef } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from './audit.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Brief 2-6 step 3 — the automated-decision record
 * (docs/agent-product-billing-investigation.md §4.3, §5; decisions 5, 6, 7).
 *
 *   A capability carries the decision types it makes about people (its
 *   profile, or the catalog default: the scheduling capabilities record as
 *   SCHEDULING, decision 7). Every decision a person approves or rejects for
 *   such a capability writes one append-only row per person it touches: the
 *   person proposed (favorable when approved) and the person it replaces
 *   (adverse when approved), with the human who decided, the bias audit in
 *   force and the jurisdiction tags. Notices, explanations and review and
 *   data requests are dated on the row as they happen, once each.
 *
 *   Floor (decision 5): an action on a person tagged as a decision about
 *   employment always needs a person (agentGates reads decisionTypesFor).
 *   Compliance hold (§4.3): SCREENING, HIRING or PROMOTION tagged NYC_LL144
 *   cannot run without a bias audit in force and notices begun at least 10
 *   business days ago.
 *
 *   Counsel reviews the fields and notice texts before notices go out
 *   (decision 6): the record is kept now; notice dates are entered by a
 *   person until the texts are signed.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const DECISION_TYPES = ['SCREENING', 'HIRING', 'PROMOTION', 'SCHEDULING', 'COMPENSATION', 'DISCIPLINE', 'TERMINATION', 'OTHER'] as const;
export const DECISION_JURISDICTIONS = ['NYC_LL144', 'CO_ADMT'] as const;
const HOLD_TYPES = new Set(['SCREENING', 'HIRING', 'PROMOTION']);

/** The catalog's own capabilities that decide something about a person (decision 7: scheduling is recorded). */
const CATALOG_DEFAULTS: Record<string, { decisionTypes: string[]; assesses: string; dataSources: string }> = {
  'shift.fill': { decisionTypes: ['SCHEDULING'], assesses: 'Who is placed at the site, free, within the scheduling rules and closest to the shift.', dataSources: 'Schedules, placements, approved leave, declared days off, rest gaps.' },
  'schedule.repair': { decisionTypes: ['SCHEDULING'], assesses: 'Who can cover a shift its holder can no longer work.', dataSources: 'Schedules, placements, approved leave, separations, emergencies.' },
  'attendance.confirm': { decisionTypes: ['SCHEDULING'], assesses: 'Whether a high-risk shift holder confirms, and who backs them up.', dataSources: 'Schedules, attendance history, replies to the confirmation.' },
};

export interface DecisionProfileView {
  capabilityKey: string;
  decisionTypes: string[];
  jurisdictions: string[];
  assesses: string;
  dataSources: string;
  retentionPolicy: string;
  humanReview: string;
  noticeStartedAt: string | null;
  noticeTextVersion: number;
  /** Whether this is the catalog default (no row saved yet). */
  isDefault: boolean;
}

const view = (p: AgentDecisionProfile): DecisionProfileView => ({
  capabilityKey: p.capabilityKey,
  decisionTypes: p.decisionTypes,
  jurisdictions: p.jurisdictions,
  assesses: p.assesses,
  dataSources: p.dataSources,
  retentionPolicy: p.retentionPolicy,
  humanReview: p.humanReview,
  noticeStartedAt: p.noticeStartedAt?.toISOString() ?? null,
  noticeTextVersion: p.noticeTextVersion,
  isDefault: false,
});

/** The profile of an agent's capability: its own row, the agent-wide row, else the catalog default, else none. */
export async function decisionProfileFor(db: Db, workerId: string, capabilityKey: string): Promise<DecisionProfileView | null> {
  const rows = await db.agentDecisionProfile.findMany({ where: { workerId, capabilityKey: { in: [capabilityKey, '*'] } } });
  const own = rows.find((r) => r.capabilityKey === capabilityKey) ?? rows.find((r) => r.capabilityKey === '*');
  if (own) return view(own);
  const d = CATALOG_DEFAULTS[capabilityKey];
  if (!d) return null;
  return { capabilityKey, decisionTypes: d.decisionTypes, jurisdictions: [], assesses: d.assesses, dataSources: d.dataSources, retentionPolicy: 'Kept at least three years.', humanReview: 'ALWAYS', noticeStartedAt: null, noticeTextVersion: 1, isDefault: true };
}

export async function decisionTypesFor(db: Db, workerId: string, capabilityKey: string): Promise<string[]> {
  return (await decisionProfileFor(db, workerId, capabilityKey))?.decisionTypes ?? [];
}

/** The bias audit in force for an agent on a date, if any. */
export async function auditInForce(db: Db, workerId: string, now: Date = new Date()) {
  return db.agentBiasAudit.findFirst({ where: { workerId, conductedAt: { lte: now }, validUntil: { gte: new Date(now.toISOString().slice(0, 10)) } }, orderBy: { conductedAt: 'desc' } });
}

/** Ten business days (Monday to Friday) before a date. */
function businessDaysBefore(now: Date, n: number): Date {
  const d = new Date(now);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

/** What keeps a capability from running in New York City, if anything (§4.3 compliance hold). */
export async function complianceHold(db: Db, workerId: string, capabilityKey: string, now: Date = new Date()): Promise<string[]> {
  const p = await decisionProfileFor(db, workerId, capabilityKey);
  if (!p || !p.jurisdictions.includes('NYC_LL144') || !p.decisionTypes.some((t) => HOLD_TYPES.has(t))) return [];
  const missing: string[] = [];
  if (!(await auditInForce(db, workerId, now))) missing.push('a bias audit in force (conducted within the past year)');
  if (!p.noticeStartedAt || new Date(p.noticeStartedAt) > businessDaysBefore(now, 10)) missing.push('notices begun at least 10 business days ago');
  return missing;
}

/**
 * A person decided an approval: write one record per person the decision
 * touches, when the capability decides about people. Called from
 * decideApproval on every path.
 */
export async function recordDecisionsForApproval(db: Db, approvalId: string, decision: 'APPROVED' | 'REJECTED', deciderId: string, now: Date = new Date()): Promise<number> {
  const proposal = await db.agentProposal.findUnique({ where: { approvalId }, select: { id: true, workerId: true, capabilityKey: true, payload: true, tenantId: true, subjectType: true } });
  if (!proposal) return 0;
  const p = await decisionProfileFor(db, proposal.workerId, proposal.capabilityKey);
  if (!p?.decisionTypes.length) return 0;
  const payload = (proposal.payload as Record<string, unknown> | null) ?? {};
  const audit = await auditInForce(db, proposal.workerId, now);
  const label = capabilityDef(proposal.capabilityKey)?.label ?? proposal.capabilityKey;
  const approved = decision === 'APPROVED';
  const touched: Array<{ associateId: string; outcome: 'FAVORABLE' | 'ADVERSE' | 'NONE'; summary: string }> = [];
  if (typeof payload.associateId === 'string') {
    touched.push({ associateId: payload.associateId, outcome: approved ? 'FAVORABLE' : 'NONE', summary: `${label}: proposed for the ${proposal.subjectType.toLowerCase()}; ${approved ? 'approved' : 'rejected'} by a person.` });
  }
  if (typeof payload.replacesAssociateId === 'string') {
    touched.push({ associateId: payload.replacesAssociateId, outcome: approved ? 'ADVERSE' : 'NONE', summary: `${label}: proposed to be replaced on the ${proposal.subjectType.toLowerCase()}; ${approved ? 'approved' : 'rejected'} by a person.` });
  }
  for (const t of touched) {
    for (const decisionType of p.decisionTypes) {
      await db.automatedDecisionRecord.create({
        data: {
          tenantId: proposal.tenantId ?? ALTO_TENANT_ID,
          workerId: proposal.workerId,
          capabilityKey: proposal.capabilityKey,
          decisionType,
          subjectAssociateId: t.associateId,
          jurisdictionTags: p.jurisdictions,
          proposalId: proposal.id,
          approvalId,
          humanReviewerId: deciderId,
          humanDecidedAt: now,
          outcome: t.outcome,
          summary: t.summary.slice(0, 500),
          auditId: audit?.id ?? null,
        },
      });
    }
  }
  return touched.length * p.decisionTypes.length;
}

/* ------------------------------------------------------------ editing */

export const DecisionProfileInputSchema = z
  .object({
    decisionTypes: z.array(z.enum(DECISION_TYPES)).max(8),
    jurisdictions: z.array(z.enum(DECISION_JURISDICTIONS)).max(2).default([]),
    assesses: z.string().trim().min(3).max(1000),
    dataSources: z.string().trim().min(3).max(1000),
    retentionPolicy: z.string().trim().min(3).max(300),
    humanReview: z.enum(['ALWAYS', 'ON_REQUEST']).default('ALWAYS'),
    noticeStartedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export async function saveDecisionProfile(db: Db, tenantId: string, workerId: string, capabilityKey: string, input: z.infer<typeof DecisionProfileInputSchema>, actorUserId: string) {
  if (capabilityKey !== '*' && !capabilityDef(capabilityKey)) throw new HttpError(400, 'capability_unknown', 'No such capability in the catalog.');
  const data = { ...input, noticeStartedAt: input.noticeStartedAt ? new Date(input.noticeStartedAt) : null };
  const row = await db.agentDecisionProfile.upsert({
    where: { workerId_capabilityKey: { workerId, capabilityKey } },
    create: { tenantId, workerId, capabilityKey, ...data, createdById: actorUserId },
    update: data,
  });
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, workerId, action: 'agent.decision_profile_saved', entityType: 'AgentDecisionProfile', entityId: row.id, metadata: { capabilityKey, ...input } as Prisma.InputJsonObject }, 'decisionRecord');
  return view(row);
}

export const BiasAuditInputSchema = z
  .object({
    auditorName: z.string().trim().min(2).max(200),
    independenceAttested: z.literal(true),
    independenceText: z.string().trim().min(10).max(1000),
    conductedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    distributionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    summaryUrl: z.string().url().max(1000).nullable().optional(),
    results: z.record(z.string(), z.unknown()),
    dataKind: z.enum(['HISTORICAL', 'TEST']),
    testDataReason: z.string().trim().min(10).max(1000).nullable().optional(),
  })
  .strict()
  .refine((a) => a.dataKind === 'HISTORICAL' || !!a.testDataReason, { message: 'Test data needs the reason historical data was not used.', path: ['testDataReason'] });

export async function addBiasAudit(db: Db, tenantId: string, workerId: string, input: z.infer<typeof BiasAuditInputSchema>, actorUserId: string) {
  const conducted = new Date(`${input.conductedAt}T00:00:00Z`);
  const validUntil = new Date(conducted);
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + 1);
  const row = await db.agentBiasAudit.create({
    data: {
      tenantId,
      workerId,
      auditorName: input.auditorName,
      independenceAttested: input.independenceAttested,
      independenceText: input.independenceText,
      conductedAt: conducted,
      validUntil,
      distributionDate: input.distributionDate ? new Date(`${input.distributionDate}T00:00:00Z`) : null,
      summaryUrl: input.summaryUrl ?? null,
      results: input.results as Prisma.InputJsonObject,
      dataKind: input.dataKind,
      testDataReason: input.testDataReason ?? null,
      createdById: actorUserId,
    },
  });
  enqueueAudit({ actorUserId, clientId: null, tenantId, workerId, action: 'agent.bias_audit_added', entityType: 'AgentBiasAudit', entityId: row.id, metadata: { auditorName: input.auditorName, conductedAt: input.conductedAt } }, 'decisionRecord');
  return row;
}

/** The lifecycle dates a person enters on a record, each once (the trigger refuses moving one). */
export const DECISION_EVENTS = ['notice_given', 'explanation_sent', 'review_requested', 'review_resolved', 'data_requested', 'data_sent'] as const;
const EVENT_COLUMN: Record<(typeof DECISION_EVENTS)[number], 'noticeGivenAt' | 'explanationSentAt' | 'reviewRequestedAt' | 'reviewResolvedAt' | 'dataRequestAt' | 'dataSentAt'> = {
  notice_given: 'noticeGivenAt',
  explanation_sent: 'explanationSentAt',
  review_requested: 'reviewRequestedAt',
  review_resolved: 'reviewResolvedAt',
  data_requested: 'dataRequestAt',
  data_sent: 'dataSentAt',
};

export async function markDecisionEvent(db: Db, tenantId: string, id: string, event: (typeof DECISION_EVENTS)[number], actorUserId: string, opts: { channel?: string; at?: Date } = {}) {
  const row = await db.automatedDecisionRecord.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'decision_not_found', 'No such decision.');
  const column = EVENT_COLUMN[event];
  if (row[column]) throw new HttpError(409, 'already_recorded', 'That date is already on the record.');
  const at = opts.at ?? new Date();
  const updated = await db.automatedDecisionRecord.update({
    where: { id },
    data: { [column]: at, ...(event === 'notice_given' ? { noticeChannel: opts.channel ?? 'EMAIL', noticeTextVersion: 1 } : {}) },
  });
  enqueueAudit({ actorUserId, clientId: null, tenantId, workerId: row.workerId, action: `agent.decision_${event}`, entityType: 'AutomatedDecisionRecord', entityId: id, metadata: { at: at.toISOString() } }, 'decisionRecord');
  return updated;
}
