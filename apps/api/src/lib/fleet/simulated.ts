import type { RobotConnectorStatus } from '@alto-people/shared';
import type { FleetConnector, FleetRobotStatus } from './types.js';

/**
 * The simulated fleet: deterministic from the external id and the clock,
 * so a test, the demo seed and the design walk all see the same robot do
 * the same thing at the same minute. A robot cycles work → charge → idle
 * over a 90-minute day; its position walks a small loop on the site map;
 * a stop holds it until a resume.
 *
 * Tests can pin a robot's reading with `setSimulatedOverride`.
 */
const CYCLE_MINUTES = 90;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const stopped = new Set<string>();
const overrides = new Map<string, Partial<FleetRobotStatus>>();
const known = new Set<string>();

/** Register a robot the simulated fleet should list (the seed and tests do). */
export function registerSimulatedRobot(externalId: string): void {
  known.add(externalId);
}

export function setSimulatedOverride(externalId: string, patch: Partial<FleetRobotStatus> | null): void {
  if (patch === null) overrides.delete(externalId);
  else overrides.set(externalId, patch);
}

export function resetSimulatedFleet(): void {
  stopped.clear();
  overrides.clear();
  known.clear();
}

export function simulatedStatus(externalId: string, now: Date): FleetRobotStatus {
  const seed = hash(externalId);
  const minuteOfDay = Math.floor(now.getTime() / 60_000);
  const phase = (minuteOfDay + (seed % CYCLE_MINUTES)) % CYCLE_MINUTES;
  // 0–54 working, 55–74 charging, 75–89 idle.
  let status: RobotConnectorStatus;
  let batteryPct: number;
  if (phase < 55) {
    status = 'WORKING';
    batteryPct = Math.max(12, 92 - Math.round((phase / 55) * 70));
  } else if (phase < 75) {
    status = 'CHARGING';
    batteryPct = Math.min(100, 22 + Math.round(((phase - 55) / 20) * 78));
  } else {
    status = 'IDLE';
    batteryPct = 100;
  }
  // A loop around the map: the origin is the robot's own corner of the site.
  const ox = 10 + (seed % 5) * 8;
  const oy = 10 + ((seed >> 3) % 5) * 8;
  const t = ((minuteOfDay + seed) % 12) / 12;
  const x = status === 'WORKING' ? ox + Math.round(Math.cos(t * Math.PI * 2) * 6 * 10) / 10 : ox;
  const y = status === 'WORKING' ? oy + Math.round(Math.sin(t * Math.PI * 2) * 6 * 10) / 10 : oy;
  const tasks = ['Bussing · section A', 'Room delivery · 1204', 'Floor scrub · lobby', 'Shelf scan · aisle 7', 'Tote run · dock'];
  const base: FleetRobotStatus = {
    externalId,
    at: now,
    status: stopped.has(externalId) ? 'STOPPED' : status,
    batteryPct,
    x,
    y,
    currentTask: status === 'WORKING' && !stopped.has(externalId) ? tasks[(seed + Math.floor(phase / 11)) % tasks.length]! : null,
    lastTaskCompletedAt: status === 'WORKING' ? new Date(now.getTime() - ((phase % 11) + 1) * 60_000) : null,
    errorCode: null,
    raw: { provider: 'SIMULATED', phase },
  };
  const o = overrides.get(externalId);
  return o ? { ...base, ...o, at: now } : base;
}

export const simulatedConnector: FleetConnector = {
  provider: 'SIMULATED',
  async listRobots(now = new Date()) {
    return [...known].sort().map((id) => simulatedStatus(id, now));
  },
  async getStatus(externalId, now = new Date()) {
    return simulatedStatus(externalId, now);
  },
  async stop(externalId) {
    stopped.add(externalId);
  },
  async resume(externalId) {
    stopped.delete(externalId);
  },
};
