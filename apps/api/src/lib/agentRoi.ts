import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * What the agents gave back, as a number beside margin on the executive's
 * hero: hours of people's time saved and what the agents cost, over the
 * trailing thirty days.
 *
 * Hours saved are an ESTIMATE from a per-capability minutes table — the
 * minutes a person would have spent doing what the proposal did once it
 * was approved — plus the assistant's answers (a question answered by the
 * registry or the model is a question a supervisor or HR didn't field).
 * Cost is what the agents reported (AgentSpend) plus a conservative
 * per-answer estimate for the model-backed assistant.
 */

const DAY = 86_400_000;
export const ROI_WINDOW_DAYS = 30;

/** Minutes a person saves when a proposal of this capability is accepted. */
export const MINUTES_SAVED_BY_CAPABILITY: Record<string, number> = {
  'shift.fill': 25,
  'attendance.confirm': 6,
  'schedule.repair': 20,
  'coverage.forecast': 45,
  'document.chase': 8,
  'i9.section2': 12,
  'incident.loop': 15,
  'coverage.credentials': 10,
};
const DEFAULT_MINUTES = 10;
/** A model-backed answer, in cents — tokens at list price, rounded up. */
const MODEL_ANSWER_CENTS = 4;
const MODEL_ANSWER_MINUTES = 4;
const RULES_ANSWER_MINUTES = 2;

export interface AgentRoi {
  windowDays: number;
  from: string;
  to: string;
  hoursSaved: number;
  costCents: number;
  /** Hours saved per dollar spent; null when nothing was spent. */
  hoursPerDollar: number | null;
  proposals: { filed: number; accepted: number; rejected: number; acceptancePct: number | null };
  assistant: { answers: number; modelAnswers: number; handoffs: number };
  perAgent: Array<{ workerId: string; name: string; filed: number; accepted: number; hoursSaved: number; costCents: number }>;
  estimate: true;
}

export async function computeAgentRoi(prisma: PrismaClient = defaultPrisma, now = new Date()): Promise<AgentRoi> {
  const tenantId = tenantIdForWrite();
  const from = new Date(now.getTime() - ROI_WINDOW_DAYS * DAY);
  const [proposals, spend, agents, asked, handoffs] = await Promise.all([
    prisma.agentProposal.findMany({
      where: { tenantId, createdAt: { gte: from, lte: now } },
      select: { workerId: true, capabilityKey: true, status: true },
    }),
    prisma.agentSpend.groupBy({
      by: ['workerId'],
      where: { tenantId, occurredAt: { gte: from, lte: now } },
      _sum: { amountCents: true },
    }),
    prisma.agentProfile.findMany({ where: { tenantId }, select: { workerId: true, builtInKey: true, worker: { select: { name: true } } } }),
    prisma.auditLog.findMany({
      where: { tenantId, action: 'hugo.asked', createdAt: { gte: from, lte: now } },
      select: { metadata: true },
      take: 20_000,
    }),
    prisma.auditLog.count({ where: { tenantId, action: 'agent.app.handoff', createdAt: { gte: from, lte: now } } }),
  ]);
  const accepted = new Set(['APPROVED', 'EXECUTED']);
  const rejected = new Set(['REJECTED']);
  const perAgent = new Map<string, { filed: number; accepted: number; minutes: number; costCents: number }>();
  const bucket = (id: string) => {
    let b = perAgent.get(id);
    if (!b) {
      b = { filed: 0, accepted: 0, minutes: 0, costCents: 0 };
      perAgent.set(id, b);
    }
    return b;
  };
  let filed = 0;
  let ok = 0;
  let no = 0;
  for (const p of proposals) {
    filed += 1;
    const b = bucket(p.workerId);
    b.filed += 1;
    if (accepted.has(p.status)) {
      ok += 1;
      b.accepted += 1;
      b.minutes += MINUTES_SAVED_BY_CAPABILITY[p.capabilityKey] ?? DEFAULT_MINUTES;
    } else if (rejected.has(p.status)) no += 1;
  }
  for (const s of spend) bucket(s.workerId).costCents += s._sum.amountCents ?? 0;
  const modelAnswers = asked.filter((a) => (a.metadata as { source?: string } | null)?.source === 'model').length;
  const rulesAnswers = asked.length - modelAnswers;
  const assistant = agents.find((a) => a.builtInKey === 'whatsapp-assistant');
  if (assistant) {
    const b = bucket(assistant.workerId);
    b.minutes += modelAnswers * MODEL_ANSWER_MINUTES + rulesAnswers * RULES_ANSWER_MINUTES;
    b.costCents += modelAnswers * MODEL_ANSWER_CENTS;
  }
  const totalMinutes = [...perAgent.values()].reduce((n, b) => n + b.minutes, 0) + (assistant ? 0 : modelAnswers * MODEL_ANSWER_MINUTES + rulesAnswers * RULES_ANSWER_MINUTES);
  const costCents = [...perAgent.values()].reduce((n, b) => n + b.costCents, 0) + (assistant ? 0 : modelAnswers * MODEL_ANSWER_CENTS);
  const hoursSaved = Math.round((totalMinutes / 60) * 10) / 10;
  const names = new Map(agents.map((a) => [a.workerId, a.worker.name]));
  return {
    windowDays: ROI_WINDOW_DAYS,
    from: from.toISOString(),
    to: now.toISOString(),
    hoursSaved,
    costCents,
    hoursPerDollar: costCents > 0 ? Math.round((hoursSaved / (costCents / 100)) * 100) / 100 : null,
    proposals: { filed, accepted: ok, rejected: no, acceptancePct: ok + no > 0 ? Math.round((ok / (ok + no)) * 100) : null },
    assistant: { answers: asked.length, modelAnswers, handoffs },
    perAgent: [...perAgent.entries()]
      .map(([workerId, b]) => ({
        workerId,
        name: names.get(workerId) ?? 'Agent',
        filed: b.filed,
        accepted: b.accepted,
        hoursSaved: Math.round((b.minutes / 60) * 10) / 10,
        costCents: b.costCents,
      }))
      .sort((a, b) => b.hoursSaved - a.hoursSaved),
    estimate: true,
  };
}
