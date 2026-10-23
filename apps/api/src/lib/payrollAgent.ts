import type { Prisma, PrismaClient } from '@prisma/client';
import { capabilityDef, type ProposalEvidence } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { inProcessAgent, logAgentAction, type AgentContext } from './agents.js';
import {
  createProposal,
  registerApprovedHandler,
  registerCapabilityMetrics,
  registerCapabilityRunner,
  supersedeProposal,
  syncProposalWithApproval,
} from './agentCapabilities.js';
import { discloserFor, userLang } from './agentDisclosure.js';
import { enqueueAudit } from './audit.js';
import { notifyAssociate, notifyManager, notifyUser } from './notify.js';
import { applyPayRateChange, currentComp } from './payChanges.js';
import { computePayrollExceptions, type PayrollExceptionRow } from './payrollExceptions.js';
import { cardOn, loadRateCards } from './rateCards.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { moduleOn } from './tenantProfile.js';
import { tenantJob } from './tenantJobs.js';

/**
 * The Payroll agent's `payroll.prep` (BEYOND).
 *
 *   Before each payroll it reads the run's exceptions (computePayrollExceptions)
 *   and puts a fix forward for each, with the evidence:
 *
 *     MISSING_W4            nudge the worker to file their W-4
 *     MISSING_COMP_RECORD   the hourly rate from the rate card in force for
 *                           the role they worked — set only on approval
 *     UNAPPROVED_TIME       nudge the person who approves their time
 *     MISSING_BANK_ACCOUNT  pay them by pay card: ask them to set one up
 *     UNSUPPORTED_STATE     the state's withholding review (one per state)
 *
 *   Every proposal goes through the PAY_CHANGE gate: nothing happens until a
 *   person approves. On approval the agent sends the nudge; a rate is set by
 *   the approver's decision and in the approver's name (applyPayRateChange
 *   with them as the actor) — the agent never changes pay on its own.
 *   A rejection stands for the run; a fix that became moot (the W-4 arrived,
 *   the time was approved) leaves the queue.
 */

type Db = PrismaClient;

export const PAYROLL_PREP = 'payroll.prep';
export const PAYROLL_AGENT_KEY = 'payroll-agent';
const CATEGORY = 'payroll.prep';
const DAY_MS = 86_400_000;

export type PrepAction = 'NUDGE_W4' | 'SET_RATE' | 'NUDGE_APPROVER' | 'PAY_CARD' | 'STATE_REVIEW';

export interface PrepException {
  associateId: string;
  associateName: string;
  kind: string;
  detail?: Record<string, unknown>;
}

export interface RateSuggestion {
  amount: number;
  position: string;
  clientId: string | null;
  clientName: string | null;
  effectiveFrom: string;
}

export interface PrepItem {
  action: PrepAction;
  associateId: string | null;
  associateName: string | null;
  exceptionKind: string;
  state?: string | null;
  rate?: RateSuggestion;
}

/**
 * The plan, pure: one fix per exception the agent knows how to fix. A missing
 * pay record without a rate card in force gets no proposal (nothing to
 * propose); an unsupported state gets one review however many people it holds.
 */
export function planPayrollPrep(exceptions: PrepException[], rates: Map<string, RateSuggestion | null>): PrepItem[] {
  const out: PrepItem[] = [];
  const states = new Set<string>();
  for (const e of exceptions) {
    switch (e.kind) {
      case 'MISSING_W4':
        out.push({ action: 'NUDGE_W4', associateId: e.associateId, associateName: e.associateName, exceptionKind: e.kind });
        break;
      case 'MISSING_COMP_RECORD': {
        const rate = rates.get(e.associateId);
        if (rate) out.push({ action: 'SET_RATE', associateId: e.associateId, associateName: e.associateName, exceptionKind: e.kind, rate });
        break;
      }
      case 'UNAPPROVED_TIME':
        out.push({ action: 'NUDGE_APPROVER', associateId: e.associateId, associateName: e.associateName, exceptionKind: e.kind });
        break;
      case 'MISSING_BANK_ACCOUNT':
        out.push({ action: 'PAY_CARD', associateId: e.associateId, associateName: e.associateName, exceptionKind: e.kind });
        break;
      case 'UNSUPPORTED_STATE': {
        const state = typeof e.detail?.state === 'string' ? e.detail.state : null;
        const key = state ?? 'none';
        if (states.has(key)) break;
        states.add(key);
        out.push({ action: 'STATE_REVIEW', associateId: null, associateName: null, exceptionKind: e.kind, state });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The agent for the tenant, or why it does not run. */
export async function payrollAgentFor(db: Db, tenantId: string): Promise<AgentContext | 'module_off' | 'agent_stopped' | 'capability_off'> {
  for (const m of capabilityDef(PAYROLL_PREP)!.requiresModule) {
    if (!(await moduleOn(m, tenantId))) return 'module_off';
  }
  const agent = await inProcessAgent(db, PAYROLL_AGENT_KEY, tenantId);
  if (!agent) return 'agent_stopped';
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: PAYROLL_PREP, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return 'capability_off';
  return agent;
}

/** The rate card in force on the period's last day for the role each person worked most. */
async function rateSuggestions(db: Db, associateIds: string[], periodStart: Date, periodEndExclusive: Date): Promise<Map<string, RateSuggestion | null>> {
  const out = new Map<string, RateSuggestion | null>();
  if (!associateIds.length) return out;
  const entries = await db.timeEntry.findMany({
    where: { associateId: { in: associateIds }, clockInAt: { gte: periodStart, lt: periodEndExclusive }, shiftId: { not: null } },
    select: { associateId: true, clientId: true, clockInAt: true, clockOutAt: true, shift: { select: { position: true, clientId: true } } },
    take: 5000,
  });
  const byPerson = new Map<string, Map<string, { clientId: string | null; position: string; minutes: number }>>();
  for (const e of entries) {
    if (!e.shift?.position) continue;
    const clientId = e.shift.clientId ?? e.clientId ?? null;
    const k = `${clientId}:${e.shift.position}`;
    const minutes = e.clockOutAt ? (e.clockOutAt.getTime() - e.clockInAt.getTime()) / 60_000 : 0;
    const m = byPerson.get(e.associateId) ?? new Map();
    const row = m.get(k) ?? { clientId, position: e.shift.position, minutes: 0 };
    row.minutes += minutes;
    m.set(k, row);
    byPerson.set(e.associateId, m);
  }
  const clientIds = [...new Set([...byPerson.values()].flatMap((m) => [...m.values()].map((r) => r.clientId)))];
  const [cards, clients] = await Promise.all([
    loadRateCards(db, clientIds),
    db.client.findMany({ where: { id: { in: clientIds.filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const on = new Date(periodEndExclusive.getTime() - DAY_MS);
  for (const id of associateIds) {
    const roles = [...(byPerson.get(id)?.values() ?? [])].sort((a, b) => b.minutes - a.minutes);
    const top = roles.find((r) => cardOn(cards, r.clientId, r.position, on));
    const card = top ? cardOn(cards, top.clientId, top.position, on) : null;
    out.set(
      id,
      card && top
        ? { amount: card.payRate, position: top.position, clientId: top.clientId, clientName: top.clientId ? (clientName.get(top.clientId) ?? null) : null, effectiveFrom: periodStart.toISOString().slice(0, 10) }
        : null,
    );
  }
  return out;
}

const money = (v: number) => `$${v.toFixed(2)}`;

function proposalText(item: PrepItem, run: { periodStart: Date; periodEnd: Date }): { summary: string; evidence: ProposalEvidence } {
  const period = `${run.periodStart.toISOString().slice(0, 10)} to ${run.periodEnd.toISOString().slice(0, 10)}`;
  const who = item.associateName ?? 'this payroll';
  const person = item.associateId && item.associateName ? [{ kind: 'person' as const, id: item.associateId, name: item.associateName }] : [];
  switch (item.action) {
    case 'NUDGE_W4':
      return {
        summary: `Ask ${who} to file a W-4 before the ${period} payroll.`,
        evidence: {
          why: `${who} has no W-4 on file, which blocks the ${period} payroll: federal income tax can't be withheld.`,
          alternatives: [{ label: 'Leave it to payroll', note: 'The run stays blocked until someone chases the form.' }],
          impact: [{ label: 'Blocks payroll', value: 'Yes' }, { label: 'What happens', value: `${who} gets a reminder with the link to the W-4` }],
          policy: null,
          affects: person,
        },
      };
    case 'SET_RATE':
      return {
        summary: `Set ${who}'s hourly rate to ${money(item.rate!.amount)} from the ${item.rate!.position} rate card${item.rate!.clientName ? ` at ${item.rate!.clientName}` : ''}, from ${item.rate!.effectiveFrom}.`,
        evidence: {
          why: `${who} has no pay record, so the ${period} payroll would pay the default hourly rate. The rate card in force for ${item.rate!.position}${item.rate!.clientName ? ` at ${item.rate!.clientName}` : ''} — the role they worked most this period — pays ${money(item.rate!.amount)} an hour.`,
          alternatives: [
            { label: 'Pay the default rate', note: 'What happens if nobody acts: the default may be under or over what the role pays.' },
            { label: 'Set a different rate', note: 'Reject this and set the rate in People → Compensation.' },
          ],
          impact: [
            { label: 'Hourly rate', value: money(item.rate!.amount) },
            { label: 'From', value: item.rate!.effectiveFrom },
            { label: 'Source', value: `${item.rate!.position} rate card` },
          ],
          policy: 'Pay changes only on a person’s approval; the rate is set in the approver’s name.',
          affects: [...person, ...(item.rate!.clientId && item.rate!.clientName ? [{ kind: 'client' as const, id: item.rate!.clientId, name: item.rate!.clientName }] : [])],
        },
      };
    case 'NUDGE_APPROVER':
      return {
        summary: `Ask ${who}'s manager to review their unapproved time before the ${period} payroll.`,
        evidence: {
          why: `${who} has clocked hours in ${period} that nobody approved. Unapproved hours are not paid, so their check would come up short.`,
          alternatives: [{ label: 'Approve it yourself', note: 'Time & attendance → timesheets.' }],
          impact: [{ label: 'What happens', value: 'Their manager gets a reminder with the link to the timesheet' }],
          policy: null,
          affects: person,
        },
      };
    case 'PAY_CARD':
      return {
        summary: `Ask ${who} to set up a pay card so the ${period} payroll can pay them.`,
        evidence: {
          why: `${who} has no bank account or pay card on file, so their pay can't be sent.`,
          alternatives: [{ label: 'Ask for bank details instead', note: 'A bank account takes a verification call; a pay card works the same day.' }],
          impact: [{ label: 'What happens', value: `${who} gets a reminder with the link to set up a pay card` }],
          policy: null,
          affects: person,
        },
      };
    case 'STATE_REVIEW':
      return {
        summary: `Review ${item.state ?? 'the work state'} withholding before the ${period} payroll.`,
        evidence: {
          why: `${item.state ? `${item.state} withholding isn't covered or reviewed yet` : 'Someone in this payroll has no work state on file'}, which blocks the ${period} payroll.`,
          alternatives: [{ label: 'Move the person to a covered state', note: 'Only if their work state is wrong.' }],
          impact: [{ label: 'Blocks payroll', value: 'Yes' }, { label: 'What happens', value: 'You get the link to the state review' }],
          policy: null,
          affects: [],
        },
      };
  }
}

export interface PayrollPrepRun {
  runs: number;
  exceptions: number;
  proposed: number;
  superseded: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** Is the exception behind a proposal still there? */
function stillOpen(action: PrepAction, associateId: string | null, state: string | null, exceptions: PayrollExceptionRow[]): boolean {
  const kind = { NUDGE_W4: 'MISSING_W4', SET_RATE: 'MISSING_COMP_RECORD', NUDGE_APPROVER: 'UNAPPROVED_TIME', PAY_CARD: 'MISSING_BANK_ACCOUNT', STATE_REVIEW: 'UNSUPPORTED_STATE' }[action];
  return exceptions.some((e) => e.kind === kind && (action === 'STATE_REVIEW' ? ((e.detail?.state as string | undefined) ?? null) === state : e.associateId === associateId));
}

/**
 * One pass for the tenant in context: every DRAFT run (or the one named),
 * its exceptions, a proposal per fix not already put forward for that run.
 */
export async function runPayrollPrep(db: Db = defaultPrisma, opts: { runId?: string; now?: Date } = {}): Promise<PayrollPrepRun> {
  const now = opts.now ?? new Date();
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: PayrollPrepRun = { runs: 0, exceptions: 0, proposed: 0, superseded: 0 };
  const agent = await payrollAgentFor(db, tenantId);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  const scopes = [...capabilityDef(PAYROLL_PREP)!.scopes];

  const runs = await db.payrollRun.findMany({
    where: { tenantId, status: 'DRAFT', ...(opts.runId ? { id: opts.runId } : {}) },
    select: { id: true, periodStart: true, periodEnd: true, clientId: true },
    orderBy: { periodStart: 'asc' },
    take: 20,
  });
  for (const run of runs) {
    out.runs += 1;
    const periodEndExclusive = new Date(run.periodEnd.getTime() + DAY_MS);
    const { exceptions } = await computePayrollExceptions(db, { periodStart: run.periodStart, periodEndExclusive, clientId: run.clientId });
    out.exceptions += exceptions.length;

    // Proposals for this run that became moot leave the queue.
    const inflight = await db.agentProposal.findMany({
      where: { tenantId, workerId: agent.workerId, capabilityKey: PAYROLL_PREP, status: 'PROPOSED', payload: { path: ['runId'], equals: run.id } },
    });
    for (const pr of inflight) {
      const p = pr.payload as { action: PrepAction; associateId: string | null; state?: string | null };
      if (!stillOpen(p.action, p.associateId, p.state ?? null, exceptions)) {
        await supersedeProposal(db, pr, 'the exception was cleared before anyone decided', now);
        out.superseded += 1;
      }
    }

    const needRate = exceptions.filter((e) => e.kind === 'MISSING_COMP_RECORD').map((e) => e.associateId);
    const rates = await rateSuggestions(db, needRate, run.periodStart, periodEndExclusive);
    const plan = planPayrollPrep(exceptions, rates);
    const earlier = await db.agentProposal.findMany({
      where: { tenantId, capabilityKey: PAYROLL_PREP, payload: { path: ['runId'], equals: run.id }, status: { in: ['PROPOSED', 'APPROVED', 'EXECUTED', 'REJECTED'] } },
      select: { payload: true },
    });
    const seen = new Set(earlier.map((e) => { const p = e.payload as { action: string; associateId: string | null; state?: string | null }; return `${p.action}:${p.associateId ?? ''}:${p.state ?? ''}`; }));
    for (const item of plan) {
      const key = `${item.action}:${item.associateId ?? ''}:${item.state ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { summary, evidence } = proposalText(item, run);
      await createProposal(
        db,
        agent,
        {
          capability: PAYROLL_PREP,
          subjectType: item.associateId ? 'Associate' : 'PayrollRun',
          subjectId: item.associateId ?? run.id,
          summary,
          payload: {
            runId: run.id,
            action: item.action,
            associateId: item.associateId,
            state: item.state ?? null,
            ...(item.rate ? { rate: item.rate.amount, effectiveFrom: item.rate.effectiveFrom, position: item.rate.position, clientId: item.rate.clientId } : {}),
          },
          evidence,
        },
        now,
      );
      out.proposed += 1;
    }
    logAgentAction(agent, { action: 'agent.payroll_prep.ran', entityType: 'PayrollRun', entityId: run.id, scopes, metadata: { exceptions: exceptions.length, proposals: plan.length } });
  }
  return out;
}

/**
 * A person approved a fix. Nudges go out from the agent; a rate is set by the
 * approver's decision, in their name. The approval is used once.
 */
export async function executePrep(
  proposal: { id: string; workerId: string; approvalId: string | null; capabilityKey: string; subjectId: string | null; tenantId: string | null; status: string; payload: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  const db = defaultPrisma;
  if (proposal.capabilityKey !== PAYROLL_PREP || !proposal.approvalId || proposal.status !== 'APPROVED') return false;
  const tenantId = proposal.tenantId ?? ALTO_TENANT_ID;
  const agent = await inProcessAgent(db, PAYROLL_AGENT_KEY, tenantId);
  if (!agent || agent.workerId !== proposal.workerId) return false;
  const approval = await db.agentApprovalRequest.findUnique({ where: { id: proposal.approvalId } });
  if (!approval || approval.status !== 'APPROVED' || !approval.decidedById) return false;
  const p = proposal.payload as { runId: string; action: PrepAction; associateId: string | null; state: string | null; rate?: number; effectiveFrom?: string; position?: string };
  const disclose = await discloserFor(db, agent);
  const scopes = [...capabilityDef(PAYROLL_PREP)!.scopes];
  let outcome: Record<string, unknown> = { action: p.action };

  if (p.action === 'SET_RATE') {
    if (!p.associateId || typeof p.rate !== 'number' || !p.effectiveFrom) return false;
    if (await currentComp(db, p.associateId)) {
      await supersedeProposal(db, proposal, 'a pay record was set another way', now);
      return false;
    }
    // The approver's decision, in the approver's name.
    const comp = await applyPayRateChange(db, {
      associateId: p.associateId,
      effectiveFrom: new Date(`${p.effectiveFrom}T00:00:00.000Z`),
      payType: 'HOURLY',
      amount: p.rate,
      reason: 'HIRE',
      notes: `From the ${p.position ? `${p.position} ` : ''}rate card, proposed by ${agent.name} and approved.`,
      actorUserId: approval.decidedById,
      requestedByUserId: null,
      note: `Payroll agent proposal ${proposal.id}`,
    });
    outcome = { ...outcome, compensationRecordId: comp.id, rate: p.rate };
  } else if (p.action === 'NUDGE_W4' && p.associateId) {
    await notifyAssociate(p.associateId, { subject: 'Your W-4 is missing', body: disclose('Payroll needs your W-4 to pay you correctly. It takes two minutes in My pay → Tax forms.', 'en'), category: CATEGORY, linkUrl: '/payroll?tab=tax', byAgentId: agent.workerId });
  } else if (p.action === 'PAY_CARD' && p.associateId) {
    await notifyAssociate(p.associateId, { subject: 'Set up how you get paid', body: disclose('We have no bank account or pay card for you, so payday can’t reach you. Set up a pay card in My pay — it works the same day.', 'en'), category: CATEGORY, linkUrl: '/payroll?tab=payout', byAgentId: agent.workerId });
  } else if (p.action === 'NUDGE_APPROVER' && p.associateId) {
    const person = await db.associate.findFirst({ where: { id: p.associateId }, select: { firstName: true, lastName: true } });
    await notifyManager(p.associateId, { subject: `Unapproved time for ${person ? `${person.firstName} ${person.lastName}` : 'your team'}`, body: disclose('Hours waiting on your approval won’t be paid in this payroll. Review the timesheet before payroll closes.', 'en'), category: CATEGORY, linkUrl: '/timesheets', byAgentId: agent.workerId });
  } else if (p.action === 'STATE_REVIEW') {
    await notifyUser(approval.decidedById, { subject: `Review ${p.state ?? 'state'} withholding`, body: disclose('The payroll can’t finalize until this state’s withholding is reviewed.', await userLang(db, approval.decidedById)), category: CATEGORY, linkUrl: '/payroll/tax-tables?tab=state', byAgentId: agent.workerId });
  }

  // Used once: the approval is consumed and the proposal carried out.
  await db.agentApprovalRequest.update({ where: { id: approval.id }, data: { status: 'CONSUMED', consumedAt: now } });
  await syncProposalWithApproval(db, approval.id, 'EXECUTED', now, outcome);
  logAgentAction(agent, { action: `agent.payroll_prep.${p.action.toLowerCase()}`, entityType: p.associateId ? 'Associate' : 'PayrollRun', entityId: p.associateId ?? p.runId, scopes, approvalId: approval.id, metadata: { ...outcome, approvedBy: approval.decidedById } });
  if (p.action === 'SET_RATE') {
    enqueueAudit({ actorUserId: approval.decidedById, clientId: null, action: 'payroll.agent_rate_approved', entityType: 'Associate', entityId: p.associateId!, metadata: { ...outcome, approvalId: approval.id, proposalId: proposal.id, workerId: agent.workerId } as Prisma.InputJsonValue }, 'payrollAgent');
  }
  return true;
}

/* ---- Registration: the executor, certification and the scorecard ------- */

let registered = false;

export function registerPayrollAgent(): void {
  if (registered) return;
  registered = true;
  registerApprovedHandler(PAYROLL_PREP, async (proposal, now) => {
    await executePrep(proposal, now);
  });
  // The plan on the fixture's exceptions: what it proposes, and that no pay moves.
  registerCapabilityRunner(PAYROLL_PREP, async (ctx) => {
    type FixtureException = { ref: string; kind: string; cardRate?: number | null; state?: string };
    const list = (Array.isArray(ctx.input.exceptions) ? ctx.input.exceptions : []) as FixtureException[];
    const rates = new Map<string, RateSuggestion | null>(
      list.filter((x) => x.kind === 'MISSING_COMP_RECORD').map((x) => [x.ref, x.cardRate ? { amount: x.cardRate, position: 'Associate', clientId: null, clientName: null, effectiveFrom: ctx.now.toISOString().slice(0, 10) } : null]),
    );
    const plan = planPayrollPrep(list.map((x) => ({ associateId: x.ref, associateName: x.ref, kind: x.kind, detail: x.state ? { state: x.state } : undefined })), rates);
    return {
      output: {
        proposals: plan.length,
        rateFor: plan.filter((p) => p.action === 'SET_RATE').map((p) => p.associateId).join(',') || null,
        stateReviews: plan.filter((p) => p.action === 'STATE_REVIEW').length,
        // Planning never touches pay: every fix is a proposal.
        payChanged: 0,
      },
      actions: plan.length ? ['propose'] : [],
    };
  });
  registerCapabilityMetrics(PAYROLL_PREP, async (db, workerId, since) => {
    const [made, approved] = await Promise.all([
      db.agentProposal.count({ where: { workerId, capabilityKey: PAYROLL_PREP, createdAt: { gte: since } } }),
      db.agentProposal.count({ where: { workerId, capabilityKey: PAYROLL_PREP, createdAt: { gte: since }, status: { in: ['APPROVED', 'EXECUTED'] } } }),
    ]);
    return { exceptionsSeen: null, proposalsMade: made, proposalsApproved: approved, blockingCleared: null };
  });
}

registerPayrollAgent();

/* ---- The cron, per tenant: every six hours over the draft runs ---------- */

let timer: NodeJS.Timeout | null = null;

export function startPayrollAgentCron(): void {
  if (timer) return;
  const tick = () =>
    void tenantJob('payrollAgent', () => runPayrollPrep())().catch((err) => {
      console.error('[alto-people/api] payroll agent sweep failed:', err);
    });
  timer = setInterval(tick, 6 * 3600 * 1000);
  timer.unref();
}
