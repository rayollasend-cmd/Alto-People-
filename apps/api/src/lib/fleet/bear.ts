import type { RobotConnectorStatus } from '@alto-people/shared';
import { offlineStatus, type FleetConnector, type FleetRobotStatus } from './types.js';

/**
 * Bear Robotics (Servi) — adapter skeleton.
 *
 * CONFIRM AGAINST THE VENDOR API before the pilot: the paths, the auth
 * header and the field names below are a reasonable reading of a fleet
 * REST API, not Bear's published contract (which needs a partner account
 * to read). Everything vendor-specific is in this one file; the rest of
 * the platform sees FleetRobotStatus only. Configure with
 * FLEET_PROVIDER=BEAR, FLEET_API_BASE, FLEET_API_KEY.
 */
interface BearRobot {
  robot_id: string;
  state: string; // e.g. 'serving' | 'charging' | 'idle' | 'error' | 'estop'
  battery: number; // 0–100
  pose?: { x: number; y: number };
  current_mission?: { name?: string } | null;
  last_mission_completed_at?: string | null;
  error?: { code?: string } | null;
}

const STATE_MAP: Record<string, RobotConnectorStatus> = {
  serving: 'WORKING',
  delivering: 'WORKING',
  bussing: 'WORKING',
  charging: 'CHARGING',
  idle: 'IDLE',
  ready: 'IDLE',
  error: 'ERROR',
  estop: 'STOPPED',
  offline: 'OFFLINE',
};

function normalize(r: BearRobot, now: Date): FleetRobotStatus {
  return {
    externalId: r.robot_id,
    at: now,
    status: STATE_MAP[(r.state ?? '').toLowerCase()] ?? 'OFFLINE',
    batteryPct: Number.isFinite(r.battery) ? Math.round(r.battery) : null,
    x: r.pose?.x ?? null,
    y: r.pose?.y ?? null,
    currentTask: r.current_mission?.name ?? null,
    lastTaskCompletedAt: r.last_mission_completed_at ? new Date(r.last_mission_completed_at) : null,
    errorCode: r.error?.code ?? null,
    raw: r,
  };
}

export function bearConnector(base: string, apiKey: string, fetchImpl: typeof fetch = fetch): FleetConnector {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const url = (path: string) => `${base.replace(/\/$/, '')}${path}`;
  return {
    provider: 'BEAR',
    async listRobots(now = new Date()) {
      try {
        const res = await fetchImpl(url('/v1/robots'), { headers });
        if (!res.ok) return [];
        const body = (await res.json()) as { robots?: BearRobot[] } | BearRobot[];
        const list = Array.isArray(body) ? body : (body.robots ?? []);
        return list.map((r) => normalize(r, now));
      } catch {
        return [];
      }
    },
    async getStatus(externalId, now = new Date()) {
      try {
        const res = await fetchImpl(url(`/v1/robots/${encodeURIComponent(externalId)}`), { headers });
        if (res.status === 404) return null;
        if (!res.ok) return offlineStatus(externalId, now, `http_${res.status}`);
        return normalize((await res.json()) as BearRobot, now);
      } catch {
        return offlineStatus(externalId, now);
      }
    },
    async stop(externalId) {
      await fetchImpl(url(`/v1/robots/${encodeURIComponent(externalId)}/estop`), { method: 'POST', headers, body: '{}' });
    },
    async resume(externalId) {
      await fetchImpl(url(`/v1/robots/${encodeURIComponent(externalId)}/resume`), { method: 'POST', headers, body: '{}' });
    },
  };
}
