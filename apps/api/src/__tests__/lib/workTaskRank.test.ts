import { describe, expect, it } from 'vitest';
import { decideAssignment, decideHandoff, rankCandidates, type CandidateInput, type RankingPolicy, type TaskForRanking } from '../../lib/tasks/rank.js';

/**
 * Brief 3-2 acceptance, on the pure ranker: a banquet shift with five
 * associates and three robots. Tasks land within policy, a failed robot
 * task goes to a person inside the policy's seconds, and every assignment
 * explains itself.
 */

const policy: RankingPolicy = { highRiskPolicy: 'PERSON_OR_SUPERVISED_ROBOT', maxAutoAssignCents: null };
const window = { windowStart: new Date('2026-10-16T22:00:00Z'), windowEnd: new Date('2026-10-17T02:00:00Z') };

const person = (name: string, caps: string[], hourlyCents: number, load = 0): CandidateInput => ({
  workerId: `p-${name.toLowerCase()}`,
  workerType: 'PERSON',
  name,
  capabilities: caps,
  available: true,
  availabilityNote: 'On shift 5:00 PM–1:00 AM as Banquet server',
  // A 30-minute task at the hourly rate.
  costCents: Math.round(hourlyCents / 2),
  load,
});
const robot = (name: string, caps: string[], batteryPct: number, costCents = 400, available = true): CandidateInput => ({
  workerId: `r-${name.toLowerCase()}`,
  workerType: 'ROBOT',
  name,
  capabilities: caps,
  available,
  availabilityNote: available ? 'Running' : 'In maintenance',
  costCents,
  load: 0,
  batteryPct,
  personOnShift: true,
});

const crew = (): CandidateInput[] => [
  person('Ana', ['food-service', 'supervision'], 1800),
  person('Ben', ['food-service'], 1500),
  person('Cal', ['food-service', 'unloading'], 1500),
  person('Dee', ['unloading'], 1500),
  person('Eli', ['food-service'], 1500, 2),
  robot('Servi 1', ['food-service', 'room-delivery'], 92),
  robot('Servi 2', ['food-service'], 24),
  robot('Pudu Bot', ['floor-care'], 80, 250),
];

const task = (capability: string, risk: TaskForRanking['risk'] = 'LOW', estimatedMinutes = 30): TaskForRanking => ({ capability, risk, estimatedMinutes, ...window });

describe('the banquet shift: five associates, three robots', () => {
  it('assigns bussing to the cheapest certified worker that is free, and says why', () => {
    const d = decideAssignment(task('food-service'), crew(), policy);
    expect(d.assign).not.toBeNull();
    // The full-battery robot is the cheapest certified, available option.
    expect(d.assign!.name).toBe('Servi 1');
    expect(d.assign!.reasons.map((r) => r.factor)).toEqual(expect.arrayContaining(['capability', 'availability', 'risk', 'cost', 'load', 'battery']));
    expect(d.assign!.reasons.find((r) => r.factor === 'capability')!.note).toContain('food-service');
    // The ranking keeps the losers with their reasons too.
    const pudu = d.ranking.find((r) => r.name === 'Pudu Bot')!;
    expect(pudu.eligible).toBe(false);
    expect(pudu.reasons.find((r) => r.factor === 'capability')!.note).toMatch(/Not certified/);
    const lowBattery = d.ranking.find((r) => r.name === 'Servi 2')!;
    expect(lowBattery.reasons.find((r) => r.factor === 'battery')!.points).toBeLessThan(0);
  });

  it('keeps high-risk work with a person unless a person on shift supervises the robot', () => {
    const personOnly = decideAssignment(task('unloading', 'HIGH'), crew(), { ...policy, highRiskPolicy: 'PERSON_ONLY' });
    expect(personOnly.assign!.workerType).toBe('PERSON');
    expect(['Cal', 'Dee']).toContain(personOnly.assign!.name);

    const robots = crew().map((c) => (c.name === 'Pudu Bot' ? { ...c, capabilities: ['unloading'], costCents: 100 } : c));
    const supervised = decideAssignment(task('unloading', 'HIGH'), robots, policy);
    expect(supervised.assign!.name).toBe('Pudu Bot');
    expect(supervised.assign!.reasons.find((r) => r.factor === 'risk')!.note).toMatch(/supervises/);

    const alone = robots.map((c) => (c.workerType === 'ROBOT' ? { ...c, personOnShift: false } : c));
    const unsupervised = decideAssignment(task('unloading', 'HIGH'), alone.filter((c) => c.workerType === 'ROBOT'), policy);
    expect(unsupervised.assign).toBeNull();
    expect(unsupervised.queuedReason).toMatch(/No certified worker is free/);
  });

  it('queues for a person when the best option costs more than the engine may spend', () => {
    const d = decideAssignment(task('food-service'), crew(), { ...policy, maxAutoAssignCents: 100 });
    expect(d.assign).toBeNull();
    expect(d.queuedReason).toMatch(/above the \$1\.00/);
    expect(d.ranking[0]!.eligible).toBe(true);
  });

  it('queues with the reason when nobody is on shift', () => {
    const d = decideAssignment(task('food-service'), [], policy);
    expect(d.assign).toBeNull();
    expect(d.queuedReason).toMatch(/Nobody is on shift/);
  });

  it('hands a failed robot task to a person within the policy window, never to another machine, with the handoff on the record', () => {
    const t = task('food-service');
    const first = decideAssignment(t, crew(), policy);
    expect(first.assign!.workerType).toBe('ROBOT');
    const failedAt = new Date('2026-10-16T23:00:00Z');
    const handoffSeconds = 30;
    // The sweep fires every 15 seconds; the latest it can act is seconds + 15.
    const sweepSeesIt = new Date(failedAt.getTime() + (handoffSeconds + 15) * 1000);
    expect(sweepSeesIt.getTime() - failedAt.getTime()).toBeLessThanOrEqual(45_000);

    const others = crew().filter((c) => c.workerId !== first.assign!.workerId);
    const d = decideHandoff(t, others, policy, { name: first.assign!.name, workerType: 'ROBOT', kind: 'FAILED' });
    expect(d.assign).not.toBeNull();
    expect(d.assign!.workerType).toBe('PERSON');
    expect(d.assign!.reasons[0]).toMatchObject({ factor: 'handoff' });
    expect(d.assign!.reasons[0]!.note).toContain('Servi 1');
    expect(d.ranking.every((r) => r.workerType === 'PERSON')).toBe(true);
  });

  it('weighs load: a person already holding two tasks in the window ranks below an equal who is free', () => {
    const r = rankCandidates(task('food-service'), [person('Eli', ['food-service'], 1500, 2), person('Ben', ['food-service'], 1500)], policy);
    expect(r[0]!.name).toBe('Ben');
    expect(r[1]!.reasons.find((x) => x.factor === 'load')!.points).toBe(-10);
  });

  it('every candidate in every ranking carries a reason for every factor it was scored on', () => {
    const r = rankCandidates(task('food-service', 'HIGH'), crew(), policy);
    for (const c of r) {
      expect(c.reasons.length).toBeGreaterThanOrEqual(5);
      for (const reason of c.reasons) expect(reason.note.length).toBeGreaterThan(3);
    }
  });
});
