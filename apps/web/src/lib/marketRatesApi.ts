import { apiFetch } from './api';

/** The market rates desk (routes/marketRates.ts). */

export interface MarketFigures {
  areaCode: string;
  areaName: string;
  socCode: string;
  socTitle: string;
  year: number;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  source: string;
  fetchedAt: string;
}

export interface MarketRow {
  key: string;
  clientId: string;
  clientName: string;
  siteId: string;
  siteName: string;
  position: string;
  payRate: number;
  billRate: number | null;
  markupPct: number | null;
  area: { code: string; name: string } | null;
  soc: { code: string; title: string } | null;
  market: MarketFigures | null;
  percentile: number | null;
  gapToMedian: number | null;
  fill: { shifts: number; filled: number; noShows: number; fillRate: number | null; noShowRate: number | null };
  recommendation: {
    payRate: number;
    billRate: number | null;
    reason: string;
    confidence: 'solid' | 'thin';
    marginPct: number;
    marginSource: 'target' | 'current' | 'default';
  } | null;
}

export interface BandStats {
  band: 'below' | 'at' | 'above';
  shifts: number;
  filled: number;
  fillRate: number | null;
  noShowRate: number | null;
}

export interface MarketRatesResponse {
  rows: MarketRow[];
  bands: Record<string, BandStats[]>;
  truncated: boolean;
  summary: { rows: number; priced: number; unmapped: number; belowMedian: number; avgRatioToMedian: number | null; lowestFill: string | null };
}

export function getMarketRates(filters: { clientId?: string; siteId?: string; position?: string } = {}): Promise<MarketRatesResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const s = qs.toString();
  return apiFetch(`/market-rates${s ? `?${s}` : ''}`);
}

export interface MarketMapping {
  sites: Array<{ id: string; name: string; clientName: string | null; place: string | null; zip: string | null; area: { code: string; name: string } | null; suggestion: { code: string; name: string; reason: string } | null }>;
  positions: Array<{ key: string; name: string; soc: { code: string; title: string } | null; suggestion: { code: string; title: string; reason: string } | null }>;
  catalog: { areas: Array<{ code: string; name: string; state: string }>; occupations: Array<{ code: string; title: string }> };
}

export function getMarketMapping(): Promise<MarketMapping> {
  return apiFetch('/market-rates/mapping');
}

export function setSiteArea(siteId: string, areaCode: string | null, areaName?: string): Promise<{ ok: true }> {
  return apiFetch('/market-rates/site-area', { method: 'PUT', body: { siteId, areaCode, ...(areaName ? { areaName } : {}) } });
}

export function setPositionSoc(position: string, socCode: string | null, socTitle?: string): Promise<{ ok: true }> {
  return apiFetch('/market-rates/position-soc', { method: 'PUT', body: { position, socCode, ...(socTitle ? { socTitle } : {}) } });
}

export function setClientMargin(clientId: string, targetMarginPct: number | null): Promise<{ ok: true }> {
  return apiFetch('/market-rates/client-margin', { method: 'PUT', body: { clientId, targetMarginPct } });
}

export interface MarketData {
  pairs: number;
  covered: number;
  missing: Array<{ areaCode: string; areaName: string; socCode: string; socTitle: string }>;
  latestYear: number | null;
  lastFetchedAt: string | null;
  sources: string[];
  apiKeyConfigured: boolean;
  refreshEveryHours: number;
}

export function getMarketData(): Promise<MarketData> {
  return apiFetch('/market-rates/data');
}

export function refreshMarketData(force = false): Promise<{ pairs: number; fetched: number; saved: number; messages: string[] }> {
  return apiFetch('/market-rates/refresh', { method: 'POST', body: { force } });
}

export function importOews(year: number, csv: string): Promise<{ rows: number; saved: number; skipped: number }> {
  return apiFetch('/market-rates/import', { method: 'POST', body: { year, csv } });
}

export const marketBriefUrl = (clientId: string) => `/api/market-rates/clients/${clientId}/brief.pdf`;
