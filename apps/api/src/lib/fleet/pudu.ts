import type { RobotConnectorStatus } from '@alto-people/shared';
import { offlineStatus, type FleetConnector, type FleetRobotStatus } from './types.js';

/**
 * Pudu Robotics (BellaBot, KettyBot, PUDU CC1) — adapter skeleton.
 *
 * CONFIRM AGAINST THE VENDOR API before the pilot: Pudu's open platform
 * signs requests with an app id and secret and reports robots by `sn`;
 * the shapes below are a reading of that style, not the published
 * contract. Everything vendor-specific stays in this file. Configure with
 * FLEET_PROVIDER=PUDU, FLEET_API_BASE, FLEET_API_KEY (the app secret).
 */
interface PuduRobot {
  sn: string;
  status: string; // e.g. 'working' | 'charging' | 'free' | 'fault' | 'offline'
  power: number; // 0–100
  position?: { x: number; y: number };
  task?: { name?: string } | null;
  task_finish_time?: string | null;
  fault_code?: string | null;
}

const STATUS_MAP: Record<string, RobotConnectorStatus> = {
  working: 'WORKING',
  delivering: 'WORKING',
  cleaning: 'WORKING',
  charging: 'CHARGING',
  free: 'IDLE',
  idle: 'IDLE',
  fault: 'ERROR',
  estop: 'STOPPED',
  offline: 'OFFLINE',
};

function normalize(r: PuduRobot, now: Date): FleetRobotStatus {
  return {
    externalId: r.sn,
    at: now,
    status: STATUS_MAP[(r.status ?? '').toLowerCase()] ?? 'OFFLINE',
    batteryPct: Number.isFinite(r.power) ? Math.round(r.power) : null,
    x: r.position?.x ?? null,
    y: r.position?.y ?? null,
    currentTask: r.task?.name ?? null,
    lastTaskCompletedAt: r.task_finish_time ? new Date(r.task_finish_time) : null,
    errorCode: r.fault_code ?? null,
    raw: r,
  };
}

export function puduConnector(base: string, apiKey: string, fetchImpl: typeof fetch = fetch): FleetConnector {
  const headers = { 'X-App-Secret': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  const url = (path: string) => `${base.replace(/\/$/, '')}${path}`;
  return {
    provider: 'PUDU',
    async listRobots(now = new Date()) {
      try {
        const res = await fetchImpl(url('/open/v1/robots'), { headers });
        if (!res.ok) return [];
        const body = (await res.json()) as { data?: PuduRobot[] } | PuduRobot[];
        const list = Array.isArray(body) ? body : (body.data ?? []);
        return list.map((r) => normalize(r, now));
      } catch {
        return [];
      }
    },
    async getStatus(externalId, now = new Date()) {
      try {
        const res = await fetchImpl(url(`/open/v1/robots/${encodeURIComponent(externalId)}`), { headers });
        if (res.status === 404) return null;
        if (!res.ok) return offlineStatus(externalId, now, `http_${res.status}`);
        const body = (await res.json()) as { data?: PuduRobot } | PuduRobot;
        const r = 'sn' in body ? body : body.data;
        return r ? normalize(r, now) : null;
      } catch {
        return offlineStatus(externalId, now);
      }
    },
    async stop(externalId) {
      await fetchImpl(url(`/open/v1/robots/${encodeURIComponent(externalId)}/stop`), { method: 'POST', headers, body: '{}' });
    },
    async resume(externalId) {
      await fetchImpl(url(`/open/v1/robots/${encodeURIComponent(externalId)}/resume`), { method: 'POST', headers, body: '{}' });
    },
  };
}
