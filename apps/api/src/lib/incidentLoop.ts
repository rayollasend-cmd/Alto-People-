import type { PrismaClient } from '@prisma/client';
import { capabilityDef, rolesWithCapability } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { claimApproval, inProcessAgent, logAgentAction } from './agents.js';
import {
  createProposal,
  registerApprovedHandler,
  registerCapabilityMetrics,
  registerCapabilityRunner,
  supersedeProposal,
  syncProposalWithApproval,
} from './agentCapabilities.js';
import { discloserFor, userLang } from './agentDisclosure.js';
import { COMPLIANCE_AGENT_KEY, complianceAgentFor } from './complianceAgent.js';
import { notifyUser } from './notify.js';
import { osha300aLine, osha300aSummary } from './osha300a.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { toWaLang } from './whatsappContent.js';
import { fmtDayInZone } from './humanDates.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * The Compliance agent's `incident.loop` (agent families step 5;
 * docs/agent-families-investigation.md §4).
 *
 *   An OSHA incident has no owner field; the compliance desk (whoever holds
 *   manage:compliance, the only role that can update or resolve one) owns
 *   it, as the relay board's "incidents" baton already says. Every open
 *   incident is a dated item on that desk; the desk hears once at 3, 7 and
 *   14 days open, with the client's OSHA 300A line for the year so far.
 *
 *   An incident that needs an HR case (recordable, days away, restricted or
 *   fatal, with a named person, open 3 days, no case yet) gets a CASE_OPEN
 *   proposal: nothing is opened until the HR desk approves; the executor
 *   then opens the case for the person (WORKPLACE_CONCERN: there is no
 *   safety category) and links it to the incident. Closing stays human:
 *   after 7 days a non-recordable incident's desk item says it can close.
 */

type Db = PrismaClient;

export const INCIDENT_LOOP = 'incident.loop';
const DAY_MS = 86_400_000;
const STAGES = [3, 7, 14] as const;
const CASE_AFTER_DAYS = 3;
const CHASE_CATEGORY = 'compliance.incidents';

export interface IncidentFacts {
  reportedAt: Date;
  status: string;
  severity: string;
  isRecordable: boolean;
  associateId: string | null;
  hrCaseId: string | null;
}

export const openDays = (i: { reportedAt: Date }, now: Date) => Math.floor((now.getTime() - i.reportedAt.getTime()) / DAY_MS);

/** 1, 2, 3 once open 3, 7, 14 days; 0 before; never for a resolved one. */
export function incidentStage(i: IncidentFacts, now: Date): number {
  if (i.status === 'RESOLVED') return 0;
  const d = openDays(i, now);
  return STAGES.filter((s) => d >= s).length;
}

/** Needs an HR case: recordable days away, restricted or fatal, a named person, open 3 days, none yet. */
export function needsHrCase(i: IncidentFacts, now: Date): boolean {
  return (
    i.status !== 'RESOLVED' &&
    i.isRecordable &&
    ['DAYS_AWAY', 'RESTRICTED_DUTY', 'FATAL'].includes(i.severity) &&
    !!i.associateId &&
    !i.hrCaseId &&
    openDays(i, now) >= CASE_AFTER_DAYS
  );
}

/** A non-recordable incident open a week: the desk may close it if the reporter has nothing to add. */
export const closable = (i: IncidentFacts, now: Date) => i.status !== 'RESOLVED' && !i.isRecordable && openDays(i, now) >= 7;

const SEVERITY_WORDS: Record<string, string> = {
  FIRST_AID: 'First aid',
  MEDICAL_TREATMENT: 'Medical treatment',
  RESTRICTED_DUTY: 'Restricted duty',
  DAYS_AWAY: 'Days away',
  FATAL: 'Fatal',
};
export const severityWords = (s: string) => SEVERITY_WORDS[s] ?? s;

const INCIDENT_SELECT = {
  id: true,
  clientId: true,
  reportedAt: true,
  occurredAt: true,
  status: true,
  severity: true,
  isRecordable: true,
  associateId: true,
  hrCaseId: true,
  chaseStage: true,
  description: true,
  daysAway: true,
  daysRestricted: true,
  client: { select: { name: true } },
  store: { select: { name: true, timezone: true } },
  associate: { select: { firstName: true, lastName: true } },
} as const;

/** The open incidents of the tenant, oldest first. */
export async function openIncidents(db: Db, tenantId: string) {
  return db.oshaIncident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, select: INCIDENT_SELECT, orderBy: { reportedAt: 'asc' }, take: 500 });
}

export type OpenIncident = Awaited<ReturnType<typeof openIncidents>>[number];
export const incidentWhere = (i: OpenIncident) => i.store?.name ?? i.client.name;
const who = (i: OpenIncident) => (i.associate ? `${i.associate.firstName} ${i.associate.lastName}` : 'no one named');

export interface IncidentLoopRun {
  open: number;
  told: number;
  proposed: number;
  superseded: number;
  executed: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** One tick for the tenant in context: retire or carry out case proposals, tell the desk, propose cases. */
export async function runIncidentLoop(db: Db = defaultPrisma, now: Date = new Date()): Promise<IncidentLoopRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: IncidentLoopRun = { open: 0, told: 0, proposed: 0, superseded: 0, executed: 0 };
  const agent = await complianceAgentFor(db, tenantId, INCIDENT_LOOP);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  const scopes = [...capabilityDef(INCIDENT_LOOP)!.scopes];

  // 1. Case proposals in flight: moot ones leave the queue, held approvals run.
  const inflight = await db.agentProposal.findMany({ where: { tenantId, workerId: agent.workerId, capabilityKey: INCIDENT_LOOP, status: { in: ['PROPOSED', 'APPROVED'] } } });
  for (const pr of inflight) {
    const inc = pr.subjectId ? await db.oshaIncident.findFirst({ where: { id: pr.subjectId, tenantId }, select: { status: true, hrCaseId: true } }) : null;
    const moot = !inc ? 'the incident no longer exists' : inc.hrCaseId ? 'a case is already open for it' : inc.status === 'RESOLVED' ? 'the incident was resolved' : null;
    if (moot) {
      await supersedeProposal(db, pr, moot, now);
      out.superseded += 1;
    } else if (pr.status === 'APPROVED') {
      if (await executeCaseOpen(pr, now)) out.executed += 1;
    }
  }

  const incidents = await openIncidents(db, tenantId);
  out.open = incidents.length;
  const desk = await db.user.findMany({ where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:compliance') } }, select: { id: true, language: true } });
  const year = now.getUTCFullYear();
  const lines = new Map<string, string>();
  // AI disclosure: each notice says the agent sent it and who answers for it, in the reader's language.
  const disclose = incidents.length ? await discloserFor(db, agent) : null;
  for (const i of incidents) {
    // 2. The desk hears once per stage.
    const stage = incidentStage(i, now);
    if (stage > i.chaseStage) {
      if (!lines.has(i.clientId)) lines.set(i.clientId, osha300aLine(await osha300aSummary(db, i.clientId, year)));
      const days = openDays(i, now);
      for (const u of desk) {
        await notifyUser(u.id, {
          subject: `Safety incident open ${days} days: ${severityWords(i.severity)} at ${incidentWhere(i)}`,
          body: disclose!(
            `${who(i)}, reported ${fmtDayInZone(i.reportedAt)}: ${i.description.slice(0, 200)}\n${closable(i, now) ? 'Nothing recordable here: close it if the reporter has nothing to add.' : 'Update it or resolve it on the OSHA page.'}\n${i.client.name}, ${lines.get(i.clientId)}`,
            toWaLang(u.language),
          ),
          category: CHASE_CATEGORY,
          linkUrl: '/compliance/osha',
          byAgentId: agent.workerId,
        });
      }
      await db.oshaIncident.update({ where: { id: i.id }, data: { chaseStage: stage, lastChasedAt: now } });
      logAgentAction(agent, { action: 'agent.incident.chased', entityType: 'OshaIncident', entityId: i.id, scopes, metadata: { stage, openDays: days } });
      out.told += 1;
    }
    // 3. An HR case, through an approval: one per incident, and a rejection stands.
    if (needsHrCase(i, now)) {
      const earlier = await db.agentProposal.count({ where: { tenantId, capabilityKey: INCIDENT_LOOP, subjectId: i.id, status: { in: ['PROPOSED', 'APPROVED', 'EXECUTED', 'REJECTED'] } } });
      if (earlier) continue;
      // The day it happened at the store (its zone, else the company's), in words.
      const occurred = fmtDayInZone(i.occurredAt, i.store?.timezone ?? companyWorkweek().timezone, { year: true });
      const days = openDays(i, now);
      const told = Math.max(stage, i.chaseStage);
      await createProposal(
        db,
        agent,
        {
          capability: INCIDENT_LOOP,
          subjectType: 'OshaIncident',
          subjectId: i.id,
          summary: `Open an HR case for ${who(i)}: ${severityWords(i.severity).toLowerCase()} incident at ${incidentWhere(i)} on ${occurred} (${i.daysAway} days away, ${i.daysRestricted} restricted), open ${openDays(i, now)} days with no case.`,
          payload: {
            associateId: i.associateId,
            category: 'WORKPLACE_CONCERN',
            priority: i.severity === 'FATAL' ? 'URGENT' : 'HIGH',
            subject: `Safety incident ${occurred}: ${severityWords(i.severity).toLowerCase()} at ${incidentWhere(i)}`.slice(0, 200),
          },
          evidence: {
            why: `A recordable ${severityWords(i.severity).toLowerCase()} incident involving ${who(i)} has been open ${days} day${days === 1 ? '' : 's'} with no HR case. ${told ? `The compliance desk has been told ${told === 1 ? 'once' : `${told} times`} and nothing changed.` : 'A case gives the person a record, a follow-up and a return-to-work plan.'}`,
            alternatives: [
              { label: 'Keep chasing the desk', note: told ? `Already told ${told === 1 ? 'once' : `${told} times`}; the incident stays open without an owner.` : 'The desk is told at 3, 7 and 14 days; the person has no case meanwhile.' },
              { label: 'Resolve the incident without a case', note: 'Not open to the agent: a recordable incident with days away or restricted duty needs a person to follow up.' },
            ],
            impact: [
              { label: 'Severity', value: severityWords(i.severity) },
              { label: 'Days away', value: String(i.daysAway) },
              { label: 'Days restricted', value: String(i.daysRestricted) },
              { label: 'Open for', value: `${days} day${days === 1 ? '' : 's'}` },
              { label: 'Case', value: `${i.severity === 'FATAL' ? 'Urgent' : 'High'} priority, workplace concern` },
            ],
            policy: null,
            affects: [
              ...(i.associateId && i.associate ? [{ kind: 'person' as const, id: i.associateId, name: who(i) }] : []),
              { kind: 'client' as const, id: i.clientId, name: i.client.name },
            ],
          },
        },
        now,
      );
      out.proposed += 1;
    }
  }
  return out;
}

/**
 * The executor: the HR desk approved a case for an incident. The agent
 * claims the approval (exactly once, as approved), opens the case for the
 * person, links it to the incident and closes the loop with the approver.
 */
export async function executeCaseOpen(
  proposal: { id: string; workerId: string; approvalId: string | null; capabilityKey: string; subjectId: string | null; tenantId: string | null; status: string },
  now: Date = new Date(),
): Promise<boolean> {
  const db = defaultPrisma;
  if (proposal.capabilityKey !== INCIDENT_LOOP || !proposal.approvalId || proposal.status !== 'APPROVED') return false;
  const tenantId = proposal.tenantId ?? ALTO_TENANT_ID;
  const agent = await inProcessAgent(db, COMPLIANCE_AGENT_KEY, tenantId);
  if (!agent || agent.workerId !== proposal.workerId) return false;
  if (typeof (await complianceAgentFor(db, tenantId, INCIDENT_LOOP)) === 'string') return false;
  const approval = await db.agentApprovalRequest.findUnique({ where: { id: proposal.approvalId } });
  if (!approval || approval.status !== 'APPROVED') return false;
  const payload = (approval.payload as Record<string, unknown>) ?? {};
  const incident = proposal.subjectId
    ? await db.oshaIncident.findFirst({ where: { id: proposal.subjectId, tenantId }, select: { id: true, hrCaseId: true, description: true, severity: true, occurredAt: true, store: { select: { timezone: true } } } })
    : null;
  if (!incident || incident.hrCaseId) {
    await supersedeProposal(db, proposal, !incident ? 'the incident no longer exists' : 'a case is already open for it', now);
    return false;
  }
  // Carried out exactly once, as approved.
  await claimApproval(db, agent, approval.id, 'CASE_OPEN', payload, now);
  const associateId = typeof payload.associateId === 'string' ? payload.associateId : null;
  const person = associateId ? await db.associate.findFirst({ where: { id: associateId, tenantId, deletedAt: null }, select: { id: true } }) : null;
  if (!person) {
    await syncProposalWithApproval(db, approval.id, 'FAILED', now, { code: 'associate_not_found', message: 'The person is no longer on file.' });
    return true;
  }
  const occurred = fmtDayInZone(incident.occurredAt, incident.store?.timezone ?? companyWorkweek().timezone, { year: true });
  const hrCase = await db.$transaction(async (tx) => {
    const c = await tx.hrCase.create({
      data: {
        tenantId,
        associateId: person.id,
        category: 'WORKPLACE_CONCERN',
        priority: payload.priority === 'URGENT' ? 'URGENT' : 'HIGH',
        subject: String(payload.subject ?? 'Safety incident').slice(0, 200),
        description: `Opened by the Compliance agent on approval, for the safety incident of ${occurred} (${severityWords(incident.severity).toLowerCase()}):\n\n${incident.description}`,
      },
      select: { id: true },
    });
    await tx.oshaIncident.update({ where: { id: incident.id }, data: { hrCaseId: c.id } });
    return c;
  });
  await syncProposalWithApproval(db, approval.id, 'EXECUTED', now, { hrCaseId: hrCase.id, incidentId: incident.id });
  logAgentAction(agent, {
    action: 'hr_case.opened',
    entityType: 'HrCase',
    entityId: hrCase.id,
    scopes: [...capabilityDef(INCIDENT_LOOP)!.scopes],
    approvalId: approval.id,
    metadata: { incidentId: incident.id, approvedBy: approval.decidedById },
  });
  if (approval.decidedById) {
    const disclose = await discloserFor(db, agent);
    await notifyUser(approval.decidedById, {
      subject: 'HR case opened for the safety incident',
      body: disclose(`Opened by ${agent.name} on your approval and linked to the incident of ${occurred}.`, await userLang(db, approval.decidedById)),
      category: CHASE_CATEGORY,
      linkUrl: `/hr-cases?case=${hrCase.id}`,
      byAgentId: agent.workerId,
    });
  }
  return true;
}

/* ---- Registration: the executor, certification and the scorecard ------- */

let registered = false;

export function registerIncidentLoop(): void {
  if (registered) return;
  registered = true;
  registerApprovedHandler(INCIDENT_LOOP, async (proposal, now) => {
    await executeCaseOpen(proposal, now);
  });
  // The rules themselves, on the fixture's incidents (days open, severity, recordable, a person, a case).
  registerCapabilityRunner(INCIDENT_LOOP, async (ctx) => {
    type FixtureIncident = { ref: string; openDays: number; severity: string; recordable: boolean; person: boolean; hasCase?: boolean };
    const list = (Array.isArray(ctx.input.incidents) ? ctx.input.incidents : []) as FixtureIncident[];
    const facts = (x: FixtureIncident): IncidentFacts => ({
      reportedAt: new Date(ctx.now.getTime() - x.openDays * DAY_MS),
      status: 'REPORTED',
      severity: x.severity,
      isRecordable: x.recordable,
      associateId: x.person ? 'someone' : null,
      hrCaseId: x.hasCase ? 'a-case' : null,
    });
    const caseFor = list.filter((x) => needsHrCase(facts(x), ctx.now)).map((x) => x.ref);
    return {
      output: { caseFor: caseFor.join(',') || null, closable: list.filter((x) => closable(facts(x), ctx.now)).map((x) => x.ref).join(',') || null },
      actions: caseFor.length ? ['propose'] : [],
    };
  });
  registerCapabilityMetrics(INCIDENT_LOOP, async (db, workerId, since) => {
    const worker = await db.worker.findUnique({ where: { id: workerId }, select: { tenantId: true } });
    const tenantId = worker?.tenantId ?? ALTO_TENANT_ID;
    const open = await db.oshaIncident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, select: { reportedAt: true } });
    const now = new Date();
    const ages = open.map((o) => (now.getTime() - o.reportedAt.getTime()) / DAY_MS).sort((a, b) => a - b);
    const median = ages.length ? Math.round(ages.length % 2 ? ages[(ages.length - 1) / 2]! : (ages[ages.length / 2 - 1]! + ages[ages.length / 2]!) / 2) : null;
    const closedAfterChase = await db.oshaIncident.count({ where: { tenantId, status: 'RESOLVED', resolvedAt: { gte: since }, chaseStage: { gt: 0 } } });
    return { openIncidents: open.length, medianAgeDays: median, closedAfterChase };
  });
}

registerIncidentLoop();
