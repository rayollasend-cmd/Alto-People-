import { describe, expect, it } from 'vitest';
import { proposeMix } from '../../lib/tasks/mix.js';
import { spanOfControl } from '../../lib/tasks/spanOfControl.js';

/**
 * Brief 3-3 — the hybrid mix and the span of control, as pure functions.
 */

const policy = { highRiskPolicy: 'PERSON_OR_SUPERVISED_ROBOT' as const, robotUtilizationPct: 50, backupCrewRatioPct: 25, robotCostPerTaskCents: { 'floor-care': 300 }, robotDefaultCostCents: 400 };

describe('proposeMix (Brief 3-3)', () => {
  it('robots take the certified task minutes up to their capacity; people take the rest, priced at the site rate', () => {
    // Two robots, 8 h shifts, 50% utilisation: 2 × 7 × 480 × 0.5 = 3,360 robot minutes a week.
    const mix = proposeMix({
      tasks: [
        { capability: 'floor-care', count: 100, minutes: 30, risk: 'LOW' }, // 3,000 min, robot-eligible
        { capability: 'food-service', count: 40, minutes: 15, risk: 'LOW' }, // 600 min, eligible, but capacity runs out
        { capability: 'supervision', count: 10, minutes: 60, risk: 'LOW' }, // 600 min, people only
      ],
      robots: [{ capabilities: ['floor-care', 'food-service'] }, { capabilities: ['floor-care', 'food-service'] }],
      policy,
      shiftMinutes: 480,
      hourlyRateCents: 1500,
      targetHoursPerWeek: 40,
    });
    expect(mix.robotCapacityMinutes).toBe(3360);
    expect(mix.taskMinutes).toBe(4200);
    // Shortest tasks first: all 40 food-service (600) then 92 of the 100 floor-care fit (2,760) = 3,360.
    expect(mix.robotMinutes).toBe(3360);
    expect(mix.robotTasks).toBe(132);
    expect(mix.personMinutes).toBe(840);
    expect(mix.personTasks).toBe(18);
    expect(mix.laborCostCents).toBe(Math.round((840 / 60) * 1500));
    expect(mix.robotCostCents).toBe(92 * 300 + 40 * 400);
    expect(mix.totalCostCents).toBe(mix.laborCostCents + mix.robotCostCents);
    expect(mix.robotsNeeded).toBe(2);
    expect(mix.backupCrew).toBe(Math.ceil((3360 * 0.25) / 480));
    expect(mix.peopleNeeded).toBe(1);
  });

  it('high-risk work stays with people when the policy says person only', () => {
    const tasks = [{ capability: 'floor-care', count: 10, minutes: 30, risk: 'HIGH' as const }];
    const robots = [{ capabilities: ['floor-care'] }];
    const strict = proposeMix({ tasks, robots, policy: { ...policy, highRiskPolicy: 'PERSON_ONLY' }, shiftMinutes: 480, hourlyRateCents: 1500, targetHoursPerWeek: 40 });
    expect(strict.robotTasks).toBe(0);
    expect(strict.personTasks).toBe(10);
    const supervised = proposeMix({ tasks, robots, policy, shiftMinutes: 480, hourlyRateCents: 1500, targetHoursPerWeek: 40 });
    expect(supervised.robotTasks).toBe(10);
  });

  it('with no robots placed, every task is people work and the backup crew is zero', () => {
    const mix = proposeMix({ tasks: [{ capability: 'floor-care', count: 10, minutes: 30, risk: 'LOW' }], robots: [], policy, shiftMinutes: 480, hourlyRateCents: 1500, targetHoursPerWeek: 40 });
    expect(mix.robotTasks).toBe(0);
    expect(mix.personMinutes).toBe(300);
    expect(mix.backupCrew).toBe(0);
    expect(mix.robotCostCents).toBe(0);
  });
});

describe('spanOfControl (Brief 3-3)', () => {
  it('counts robots against the leads on the floor at the policy limit', () => {
    expect(spanOfControl(0, 0, 4)).toMatchObject({ exceeded: false, allowed: 0, text: 'No robots on shift.' });
    expect(spanOfControl(3, 1, 4)).toMatchObject({ exceeded: false, allowed: 4 });
    const over = spanOfControl(9, 2, 4);
    expect(over.exceeded).toBe(true);
    expect(over.allowed).toBe(8);
    expect(over.text).toContain('1 over the 4-per-lead limit');
    expect(spanOfControl(2, 0, 4).text).toContain('no crew lead on the floor');
  });
});
