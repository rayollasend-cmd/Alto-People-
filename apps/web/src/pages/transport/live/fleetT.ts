import { useI18n } from '@/lib/i18n';
import type { enFleetOps } from '@/lib/i18n/en/fleetOps';
import '@/lib/i18n/en/fleetOps';

/**
 * t() for the desk's live operations ('fleetOps.*', en/fleetOps.ts with its
 * Spanish in es/fleetOps.ts). Typed against the pack itself, so it compiles
 * whether or not the pack is listed in en/keys.ts yet.
 */
export type FleetKey = keyof typeof enFleetOps;
export type FleetT = (key: FleetKey, vars?: Record<string, string | number>) => string;

export function useFleetT(): FleetT {
  const { t } = useI18n();
  return t as unknown as FleetT;
}

/** "just now" · "6 min ago" · "1h 5m ago" · "3 days ago". */
export function agoText(t: FleetT, minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 1) return t('fleetOps.justNow');
  if (minutes < 60) return t('fleetOps.minAgo', { n: minutes });
  if (minutes >= 24 * 60) return t('fleetOps.dAgo', { count: Math.floor(minutes / (24 * 60)) });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return t('fleetOps.hAgo', { time: m ? `${h}h ${m}m` : `${h}h` });
}

/** "4 min" · "1h 5m". */
export function minutesText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
