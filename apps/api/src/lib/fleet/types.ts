import type { FleetProvider, RobotConnectorStatus } from '@alto-people/shared';

/**
 * Brief 3-1 — the one interface every fleet speaks through.
 *
 * A connector answers for the robots a manufacturer's fleet software
 * knows by their external id. The platform polls it once a minute per
 * tenant (lib/robots.ts sampleRobots) and stores a time series; a
 * connector that can push may also `subscribe`. Everything a connector
 * returns is normalized here so no screen or rule ever sees a vendor's
 * own field names.
 */
export interface FleetRobotStatus {
  externalId: string;
  at: Date;
  status: RobotConnectorStatus;
  batteryPct: number | null;
  /** Site-local map coordinates in the commissioning map's units. */
  x: number | null;
  y: number | null;
  currentTask: string | null;
  lastTaskCompletedAt: Date | null;
  errorCode: string | null;
  /** The vendor's own payload, kept for evidence. */
  raw?: unknown;
}

export interface FleetConnector {
  readonly provider: FleetProvider;
  /** Every robot the fleet knows. */
  listRobots(now?: Date): Promise<FleetRobotStatus[]>;
  /** One robot by its fleet-side id; null when the fleet does not know it. */
  getStatus(externalId: string, now?: Date): Promise<FleetRobotStatus | null>;
  /** Ask the fleet to halt a robot (the platform's emergency stop). */
  stop(externalId: string): Promise<void>;
  /** Ask the fleet to let a robot work again. */
  resume(externalId: string): Promise<void>;
  /** Optional push channel; the poll stays the source of truth. */
  subscribe?(onStatus: (s: FleetRobotStatus) => void): () => void;
}

export function offlineStatus(externalId: string, now: Date, errorCode = 'unreachable'): FleetRobotStatus {
  return { externalId, at: now, status: 'OFFLINE', batteryPct: null, x: null, y: null, currentTask: null, lastTaskCompletedAt: null, errorCode };
}
