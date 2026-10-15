import type { AssignmentReason, WorkTaskHighRiskPolicy, RankedCandidate, WorkTaskRisk } from '@alto-people/shared';

/**
 * Brief 3-2: the ranking, as a pure function. The database adapter
 * (engine.ts) gathers candidates; this file decides, and it decides the
 * same way in a unit test as in production, so the banquet acceptance
 * test runs without Postgres.
 *
 * Every candidate gets every factor as a reason, points and a line a
 * supervisor can read. Ineligible candidates stay in the ranking with
 * their reasons: "why not the robot" is half of explainability.
 */

export interface TaskForRanking {
  capability: string;
  risk: WorkTaskRisk;
  estimatedMinutes: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface CandidateInput {
  workerId: string;
  workerType: 'PERSON' | 'AGENT' | 'ROBOT';
  name: string;
  /** Capability codes the worker is certified for (Worker.capabilities). */
  capabilities: readonly string[];
  /** Free in the task's window: on shift (a person), running (a robot or agent). */
  available: boolean;
  /** "On shift 2:00–10:00 PM" / "Off shift" / "In maintenance". */
  availabilityNote: string;
  /** What this task costs with this worker, in cents. */
  costCents: number;
  /** Tasks already held in the same window. */
  load: number;
  /** Robots only. */
  batteryPct?: number | null;
  /** Robots only: a person on shift at the site in the window can supervise it. */
  personOnShift?: boolean;
}

export interface RankingPolicy {
  highRiskPolicy: WorkTaskHighRiskPolicy;
  maxAutoAssignCents: number | null;
}

export interface RankingDecision {
  ranking: RankedCandidate[];
  /** The winner the engine may assign on its own, or null. */
  assign: RankedCandidate | null;
  /** When `assign` is null: why a person has to decide. */
  queuedReason: string | null;
}

const CAPABILITY_POINTS = 40;
const AVAILABILITY_POINTS = 30;
const COST_POINTS = 20;
const LOAD_PENALTY_PER_TASK = 5;
const LOW_BATTERY_PCT = 30;
const LOW_BATTERY_PENALTY = 15;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Rank every candidate for a task; eligible ones first, best first. */
export function rankCandidates(task: TaskForRanking, candidates: readonly CandidateInput[], policy: RankingPolicy): RankedCandidate[] {
  const costs = candidates.filter((c) => c.available && c.capabilities.includes(task.capability)).map((c) => c.costCents);
  const maxCost = Math.max(1, ...costs);
  const minCost = costs.length ? Math.min(...costs) : 0;

  const ranked = candidates.map((c): RankedCandidate => {
    const reasons: AssignmentReason[] = [];
    let eligible = true;
    let score = 0;

    const certified = c.capabilities.includes(task.capability);
    if (certified) {
      score += CAPABILITY_POINTS;
      reasons.push({ factor: 'capability', points: CAPABILITY_POINTS, note: `Certified for ${task.capability}` });
    } else {
      eligible = false;
      reasons.push({ factor: 'capability', points: 0, note: `Not certified for ${task.capability}` });
    }

    if (c.available) {
      score += AVAILABILITY_POINTS;
      reasons.push({ factor: 'availability', points: AVAILABILITY_POINTS, note: c.availabilityNote });
    } else {
      eligible = false;
      reasons.push({ factor: 'availability', points: 0, note: c.availabilityNote });
    }

    if (task.risk === 'HIGH') {
      if (c.workerType === 'PERSON') {
        reasons.push({ factor: 'risk', points: 0, note: 'High-risk work: a person may hold it' });
      } else if (c.workerType === 'ROBOT' && policy.highRiskPolicy === 'PERSON_OR_SUPERVISED_ROBOT' && c.personOnShift) {
        reasons.push({ factor: 'risk', points: 0, note: 'High-risk work: a person on shift supervises this robot' });
      } else {
        eligible = false;
        reasons.push({
          factor: 'risk',
          points: 0,
          note:
            c.workerType === 'ROBOT'
              ? policy.highRiskPolicy === 'PERSON_ONLY'
                ? 'High-risk work: the policy allows a person only'
                : 'High-risk work: no person on shift to supervise this robot'
              : 'High-risk work: an agent may not hold it',
        });
      }
    } else {
      reasons.push({ factor: 'risk', points: 0, note: `${task.risk === 'MEDIUM' ? 'Medium' : 'Low'}-risk work: any certified worker may hold it` });
    }

    // Cheaper is better: full points at the cheapest eligible cost, none at the dearest.
    const costPoints = eligible && maxCost > minCost ? Math.round((COST_POINTS * (maxCost - c.costCents)) / (maxCost - minCost)) : eligible ? COST_POINTS : 0;
    score += costPoints;
    reasons.push({ factor: 'cost', points: costPoints, note: `${dollars(c.costCents)} for this task` });

    const loadPenalty = Math.min(AVAILABILITY_POINTS, c.load * LOAD_PENALTY_PER_TASK);
    if (loadPenalty > 0) {
      score -= loadPenalty;
      reasons.push({ factor: 'load', points: -loadPenalty, note: `${c.load} other task${c.load === 1 ? '' : 's'} in the same window` });
    } else {
      reasons.push({ factor: 'load', points: 0, note: 'No other task in the window' });
    }

    if (c.workerType === 'ROBOT' && typeof c.batteryPct === 'number') {
      if (c.batteryPct < LOW_BATTERY_PCT) {
        score -= LOW_BATTERY_PENALTY;
        reasons.push({ factor: 'battery', points: -LOW_BATTERY_PENALTY, note: `Battery at ${c.batteryPct}%` });
      } else {
        reasons.push({ factor: 'battery', points: 0, note: `Battery at ${c.batteryPct}%` });
      }
    }

    return { workerId: c.workerId, workerType: c.workerType, name: c.name, eligible, score: Math.max(0, score), costCents: c.costCents, reasons };
  });

  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (a.costCents !== b.costCents) return a.costCents - b.costCents;
    return a.name.localeCompare(b.name);
  });
  return ranked;
}

/** Rank, then decide: assign the winner within policy, else queue with the reason. */
export function decideAssignment(task: TaskForRanking, candidates: readonly CandidateInput[], policy: RankingPolicy): RankingDecision {
  const ranking = rankCandidates(task, candidates, policy);
  const best = ranking.find((r) => r.eligible) ?? null;
  if (!best) {
    const reason = candidates.length === 0 ? 'Nobody is on shift at this site in the window' : `No certified worker is free in the window (${ranking.length} weighed)`;
    return { ranking, assign: null, queuedReason: reason };
  }
  if (policy.maxAutoAssignCents !== null && best.costCents > policy.maxAutoAssignCents) {
    return {
      ranking,
      assign: null,
      queuedReason: `Best option costs ${dollars(best.costCents)}, above the ${dollars(policy.maxAutoAssignCents)} the engine may assign on its own`,
    };
  }
  return { ranking, assign: best, queuedReason: null };
}

/**
 * The handoff: a robot's or agent's task that stalled or failed goes to a
 * PERSON — never to another machine — ranked the same way, with the handoff
 * itself on the record as a reason.
 */
export function decideHandoff(task: TaskForRanking, candidates: readonly CandidateInput[], policy: RankingPolicy, from: { name: string; workerType: string; kind: 'STALLED' | 'FAILED' }): RankingDecision {
  const people = candidates.filter((c) => c.workerType === 'PERSON');
  const decision = decideAssignment(task, people, { ...policy, maxAutoAssignCents: null });
  const note = `Took over from ${from.name} (${from.workerType.toLowerCase()} ${from.kind.toLowerCase()})`;
  for (const r of decision.ranking) r.reasons.unshift({ factor: 'handoff', points: 0, note });
  if (decision.assign) decision.assign.reasons = decision.ranking.find((r) => r.workerId === decision.assign!.workerId)!.reasons;
  if (!decision.assign) decision.queuedReason = `${note}; no person is free in the window`;
  return decision;
}
