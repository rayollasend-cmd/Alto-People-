import type { SeasonTaskDemandLine, SeasonWeekMix, WorkTaskRisk } from '@alto-people/shared';

/**
 * Brief 3-3: the hybrid mix for one site-week, as a pure function.
 *
 * Demand arrives as tasks (a type, how many a week, minutes each, risk).
 * Robots take the task minutes they are certified for, within the risk
 * policy, up to their capacity for the week (robots × days × shift minutes
 * × utilisation); people take the rest. The week's labor cost is the
 * people's minutes at the site's hourly rate, the robot cost is the robot
 * tasks at the policy's cost per task, and the backup crew is the standby
 * people a robot-dependent week needs: robot minutes × the backup ratio,
 * in shifts.
 */

export interface MixRobot {
  capabilities: readonly string[];
}

export interface MixPolicy {
  highRiskPolicy: 'PERSON_ONLY' | 'PERSON_OR_SUPERVISED_ROBOT';
  robotUtilizationPct: number;
  backupCrewRatioPct: number;
  robotCostPerTaskCents: Record<string, number>;
  robotDefaultCostCents: number;
}

export interface MixInput {
  tasks: readonly SeasonTaskDemandLine[];
  robots: readonly MixRobot[];
  policy: MixPolicy;
  /** Minutes in one shift (the plan's shift hours × 60). */
  shiftMinutes: number;
  /** Days the site runs in the week (7 for a store). */
  daysPerWeek?: number;
  /** The site's hourly pay rate for the people's minutes, in cents. */
  hourlyRateCents: number;
  /** The plan's target hours per person per week, to turn people minutes into heads. */
  targetHoursPerWeek: number;
}

const riskEligible = (risk: WorkTaskRisk, policy: MixPolicy['highRiskPolicy']) => risk !== 'HIGH' || policy === 'PERSON_OR_SUPERVISED_ROBOT';

export function proposeMix(input: MixInput): SeasonWeekMix {
  const days = input.daysPerWeek ?? 7;
  const robotCount = input.robots.length;
  const capacityMinutes = Math.round(robotCount * days * input.shiftMinutes * (Math.max(0, Math.min(100, input.policy.robotUtilizationPct)) / 100));
  const robotCaps = new Set(input.robots.flatMap((r) => r.capabilities));

  let taskMinutes = 0;
  let robotMinutes = 0;
  let robotTasks = 0;
  let personTasks = 0;
  let robotCostCents = 0;
  let capacityLeft = capacityMinutes;
  const lines = [...input.tasks].sort((a, b) => a.minutes - b.minutes);
  for (const line of lines) {
    const count = Math.max(0, Math.floor(line.count));
    const minutes = Math.max(0, line.minutes);
    taskMinutes += count * minutes;
    const eligible = robotCount > 0 && robotCaps.has(line.capability) && riskEligible(line.risk, input.policy.highRiskPolicy);
    let toRobot = 0;
    if (eligible && minutes > 0) toRobot = Math.min(count, Math.floor(capacityLeft / minutes));
    else if (eligible && minutes === 0) toRobot = count;
    robotTasks += toRobot;
    personTasks += count - toRobot;
    robotMinutes += toRobot * minutes;
    capacityLeft -= toRobot * minutes;
    robotCostCents += toRobot * (input.policy.robotCostPerTaskCents[line.capability] ?? input.policy.robotDefaultCostCents);
  }
  const personMinutes = taskMinutes - robotMinutes;
  const laborCostCents = Math.round((personMinutes / 60) * input.hourlyRateCents);
  const robotsNeeded = robotMinutes === 0 ? 0 : Math.ceil(robotMinutes / Math.max(1, days * input.shiftMinutes * (input.policy.robotUtilizationPct / 100)));
  const backupCrew = robotMinutes === 0 ? 0 : Math.ceil((robotMinutes * (input.policy.backupCrewRatioPct / 100)) / Math.max(1, input.shiftMinutes));
  const peopleNeeded = personMinutes === 0 ? 0 : Math.ceil(personMinutes / Math.max(60, input.targetHoursPerWeek * 60));
  return {
    taskMinutes,
    robotMinutes,
    personMinutes,
    robotTasks,
    personTasks,
    robotsNeeded,
    robotCapacityMinutes: capacityMinutes,
    peopleNeeded,
    backupCrew,
    laborCostCents,
    robotCostCents,
    totalCostCents: laborCostCents + robotCostCents,
  };
}
