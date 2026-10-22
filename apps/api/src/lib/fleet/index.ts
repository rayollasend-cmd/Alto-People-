import type { FleetProvider } from '@alto-people/shared';
import { env } from '../../config/env.js';
import { bearConnector } from './bear.js';
import { puduConnector } from './pudu.js';
import { simulatedConnector } from './simulated.js';
import type { FleetConnector } from './types.js';

export type { FleetConnector, FleetRobotStatus } from './types.js';
export { registerSimulatedRobot, resetSimulatedFleet, setSimulatedOverride, simulatedStatus } from './simulated.js';

/**
 * The fleet the platform talks to, by environment:
 *   FLEET_PROVIDER = SIMULATED (default) | BEAR | PUDU   (config/env.ts)
 *   FLEET_API_BASE, FLEET_API_KEY for a real fleet.
 * A robot whose profile names a different provider than the environment
 * is read through the simulated fleet, so a demo never calls a vendor.
 */
export function fleetProviderFromEnv(): FleetProvider {
  return env.FLEET_PROVIDER;
}

let cached: { provider: FleetProvider; connector: FleetConnector } | null = null;

export function fleetConnector(provider: FleetProvider = fleetProviderFromEnv()): FleetConnector {
  const base = env.FLEET_API_BASE ?? '';
  const key = env.FLEET_API_KEY ?? '';
  if (provider !== 'SIMULATED' && (!base || !key)) return simulatedConnector;
  if (cached && cached.provider === provider) return cached.connector;
  const connector = provider === 'BEAR' ? bearConnector(base, key) : provider === 'PUDU' ? puduConnector(base, key) : simulatedConnector;
  cached = { provider, connector };
  return connector;
}

/** Tests swap the environment; the cache must follow. */
export function resetFleetConnectorCache(): void {
  cached = null;
}
